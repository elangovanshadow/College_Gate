import { requestUrl } from "obsidian";
import { OneDriveSettings, RemoteEntry, SyncProvider, Upload } from "../types";
import { HttpError, http, pool, quickXorHash } from "../util";

const GRAPH = "https://graph.microsoft.com/v1.0";
/** Read/write access to your OneDrive files, plus a refresh token so you stay signed in. */
const SCOPE = "Files.ReadWrite offline_access";
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 20; // upload-session chunks must be multiples of 320 KiB
const INVALID_CHARS = /["*:<>?\\|]/;
const RESERVED = /^(\.lock|CON|PRN|AUX|NUL|COM\d|LPT\d|desktop\.ini|_vti_.*)$/i;

function authUrl(tenant: string, path: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant || "common")}/oauth2/v2.0/${path}`;
}

function form(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter((p) => p)
    .map(encodeURIComponent)
    .join("/");
}

/** Why OneDrive would reject this path, or null if it is fine. */
function invalidName(path: string): string | null {
  for (const seg of path.split("/")) {
    if (INVALID_CHARS.test(seg)) return `contains one of " * : < > ? \\ |`;
    if (RESERVED.test(seg) || seg.startsWith("~$")) return "reserved name";
    if (/[ .]$/.test(seg) || /^ /.test(seg)) return "starts/ends with a space or ends with a dot";
  }
  return null;
}

export interface MsDeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

function msError(j: any, status: number): string {
  const d: string = j?.error_description ?? "";
  if (d.includes("AADSTS7000218") || d.includes("AADSTS700016")) {
    return "the app registration is not set up for this sign-in. Check the client ID, and that 'Allow public client flows' is on.";
  }
  if (d.includes("AADSTS65001") || d.includes("AADSTS90094")) {
    return "your school requires an administrator to approve this app. Ask your IT team to grant consent.";
  }
  return (d.split("\r\n")[0] || j?.error || `HTTP ${status}`) as string;
}

/** Step 1 of the Microsoft device-code sign-in. */
export async function msStartDeviceFlow(clientId: string, tenant: string): Promise<MsDeviceCode> {
  const res = await requestUrl({
    url: authUrl(tenant, "devicecode"),
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form({ client_id: clientId, scope: SCOPE }),
    throw: false,
  });
  if (res.status >= 400) throw new Error(`Microsoft sign-in failed: ${msError(res.json, res.status)}`);
  return res.json;
}

/** Step 2: poll until the user approves. */
export async function msPollDeviceFlow(
  s: OneDriveSettings,
  code: MsDeviceCode,
  isCancelled: () => boolean
): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  let interval = Math.max(code.interval, 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (isCancelled()) throw new Error("Cancelled.");
    const res = await requestUrl({
      url: authUrl(s.tenant, "token"),
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        client_id: s.clientId,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      throw: false,
    });
    const j = res.json;
    if (res.status < 400 && j.refresh_token) {
      return { refreshToken: j.refresh_token, accessToken: j.access_token, expiresIn: j.expires_in };
    }
    if (j?.error === "authorization_pending") continue;
    if (j?.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new Error(`Microsoft sign-in failed: ${msError(j, res.status)}`);
  }
  throw new Error("Microsoft sign-in timed out. Try again.");
}

/**
 * Stores the vault as a normal folder tree in OneDrive (personal, or Microsoft 365 work/school).
 * Uses OneDrive's own QuickXorHash so changes are detected without downloading anything.
 */
export class OneDriveProvider implements SyncProvider {
  readonly name = "OneDrive";
  readonly hashAlgo = "quickxor";
  private folderId = "";

  constructor(private s: OneDriveSettings, private save: () => Promise<void>) {}

  async hash(data: ArrayBuffer): Promise<string> {
    return quickXorHash(data);
  }

  validate(): void {
    if (!this.s.clientId) throw new Error("OneDrive: application (client) ID is not set.");
    if (!this.s.refreshToken) throw new Error("OneDrive: not signed in. Use 'Sign in with Microsoft' in settings.");
    if (!this.s.folderName) throw new Error("OneDrive: folder name is not set.");
  }

  private async token(): Promise<string> {
    if (this.s.accessToken && Date.now() < this.s.accessTokenExpiry - 60_000) return this.s.accessToken;
    const res = await requestUrl({
      url: authUrl(this.s.tenant, "token"),
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        client_id: this.s.clientId,
        grant_type: "refresh_token",
        refresh_token: this.s.refreshToken,
        scope: SCOPE,
      }),
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(`OneDrive: sign-in expired (${msError(res.json, res.status)}). Sign in again in settings.`);
    }
    const j = res.json;
    this.s.accessToken = j.access_token;
    this.s.accessTokenExpiry = Date.now() + j.expires_in * 1000;
    if (j.refresh_token) this.s.refreshToken = j.refresh_token; // Microsoft rotates refresh tokens
    await this.save();
    return this.s.accessToken;
  }

  /** Graph request with retry on throttling (429/503/504). */
  private async api(method: string, url: string, body?: unknown, raw?: ArrayBuffer): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await http({
          url: url.startsWith("http") ? url : `${GRAPH}${url}`,
          method,
          headers: { Authorization: `Bearer ${await this.token()}` },
          contentType: raw ? "application/octet-stream" : body ? "application/json" : undefined,
          body: raw ?? (body ? JSON.stringify(body) : undefined),
        });
        return res.status === 204 || !res.text ? null : res.json;
      } catch (e) {
        if (e instanceof HttpError && [429, 503, 504].includes(e.status) && attempt < 4) {
          await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
          continue;
        }
        throw e;
      }
    }
  }

  private async ensureFolder(): Promise<string> {
    let parent = "root";
    let path = "";
    for (const seg of this.s.folderName.split("/").filter((p) => p)) {
      path = path ? `${path}/${seg}` : seg;
      try {
        parent = (await this.api("GET", `/me/drive/root:/${encodePath(path)}?$select=id`)).id;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
        const created = await this.api("POST", `/me/drive/items/${parent}/children`, {
          name: seg,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        });
        parent = created.id;
      }
    }
    this.folderId = parent;
    return parent;
  }

  async list(): Promise<Map<string, RemoteEntry>> {
    const out = new Map<string, RemoteEntry>();
    let level: { id: string; prefix: string }[] = [{ id: await this.ensureFolder(), prefix: "" }];
    while (level.length) {
      const next: { id: string; prefix: string }[] = [];
      await pool(level, 4, async ({ id, prefix }) => {
        let url: string | undefined = `/me/drive/items/${id}/children?$top=999&$select=id,name,file,folder`;
        while (url) {
          const page: any = await this.api("GET", url);
          for (const item of page.value ?? []) {
            const path = prefix ? `${prefix}/${item.name}` : item.name;
            if (item.folder) next.push({ id: item.id, prefix: path });
            else if (item.file) {
              out.set(path, { path, id: item.id, hash: item.file.hashes?.quickXorHash ?? `unknown:${item.id}` });
            }
          }
          url = page["@odata.nextLink"];
        }
      });
      level = next;
    }
    return out;
  }

  async download(entry: RemoteEntry): Promise<ArrayBuffer> {
    const item = await this.api("GET", `/me/drive/items/${entry.id}?$select=id,@microsoft.graph.downloadUrl`);
    const res = await http({ url: item["@microsoft.graph.downloadUrl"] });
    return res.arrayBuffer;
  }

  private itemPath(path: string): string {
    return `/me/drive/root:/${encodePath(`${this.s.folderName}/${path}`)}:`;
  }

  private async upload(u: Upload): Promise<void> {
    if (u.data.byteLength <= SIMPLE_UPLOAD_LIMIT) {
      // Missing parent folders are created automatically.
      await this.api("PUT", `${this.itemPath(u.path)}/content`, undefined, u.data);
      return;
    }
    const session = await this.api("POST", `${this.itemPath(u.path)}/createUploadSession`, {
      item: { "@microsoft.graph.conflictBehavior": "replace" },
    });
    const total = u.data.byteLength;
    for (let start = 0; start < total; start += CHUNK) {
      const end = Math.min(start + CHUNK, total);
      // The upload URL is pre-authenticated; sending the bearer token here is not allowed.
      await http({
        url: session.uploadUrl,
        method: "PUT",
        headers: { "Content-Range": `bytes ${start}-${end - 1}/${total}` },
        contentType: "application/octet-stream",
        body: u.data.slice(start, end),
      });
    }
  }

  async apply(uploads: Upload[], deletes: RemoteEntry[]): Promise<string[]> {
    const rejected: string[] = [];
    await pool(uploads, 4, async (u) => {
      const why = invalidName(u.path);
      if (why) {
        console.warn(`Cloud Sync: OneDrive can't store "${u.path}": ${why}`);
        rejected.push(u.path);
        return;
      }
      await this.upload(u);
    });
    // Deleted files go to the OneDrive recycle bin.
    await pool(deletes, 4, async (d) => {
      try {
        await this.api("DELETE", `/me/drive/items/${d.id}`);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
    });
    return rejected;
  }
}

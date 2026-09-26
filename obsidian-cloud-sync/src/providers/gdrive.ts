import { requestUrl } from "obsidian";
import { GDriveSettings, RemoteEntry, SyncProvider, Upload } from "../types";
import { HttpError, http, pool } from "../util";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEVICE_URL = "https://oauth2.googleapis.com/device/code";
/** Only grants access to files this plugin created — not the rest of your Drive. */
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function form(data: Record<string, string>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

/** Step 1 of the OAuth device flow: get a code the user enters at google.com/device. */
export async function startDeviceFlow(clientId: string): Promise<DeviceCode> {
  const res = await http({
    url: DEVICE_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form({ client_id: clientId, scope: SCOPE }),
  });
  return res.json;
}

/** Step 2: poll until the user approves. Resolves with the refresh token. */
export async function pollDeviceFlow(
  s: GDriveSettings,
  code: DeviceCode,
  isCancelled: () => boolean
): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  let interval = Math.max(code.interval, 5) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (isCancelled()) throw new Error("Cancelled.");
    const res = await requestUrl({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        client_id: s.clientId,
        client_secret: s.clientSecret,
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
    throw new Error(`Google sign-in failed: ${j?.error_description || j?.error || res.status}`);
  }
  throw new Error("Google sign-in timed out. Try again.");
}

/**
 * Stores the vault as a flat set of files inside one Drive folder. Each Drive file is
 * named after its vault path (e.g. "Daily/2026-09-26.md") and carries the content hash
 * in appProperties so changes can be detected without downloading.
 */
export class GDriveProvider implements SyncProvider {
  readonly name = "Google Drive";
  private remote = new Map<string, RemoteEntry>();

  constructor(private s: GDriveSettings, private save: () => Promise<void>) {}

  validate(): void {
    if (!this.s.clientId || !this.s.clientSecret) throw new Error("Google Drive: OAuth client ID/secret is not set.");
    if (!this.s.refreshToken) throw new Error("Google Drive: not signed in. Use 'Sign in with Google' in settings.");
    if (!this.s.folderName) throw new Error("Google Drive: folder name is not set.");
  }

  private async token(): Promise<string> {
    if (this.s.accessToken && Date.now() < this.s.accessTokenExpiry - 60_000) return this.s.accessToken;
    const res = await http({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        client_id: this.s.clientId,
        client_secret: this.s.clientSecret,
        refresh_token: this.s.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    this.s.accessToken = res.json.access_token;
    this.s.accessTokenExpiry = Date.now() + res.json.expires_in * 1000;
    await this.save();
    return this.s.accessToken;
  }

  private async api(method: string, url: string, body?: unknown): Promise<any> {
    const res = await http({
      url,
      method,
      headers: { Authorization: `Bearer ${await this.token()}` },
      contentType: body ? "application/json" : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.status === 204 || !res.text ? null : res.json;
  }

  private async ensureFolder(): Promise<string> {
    if (this.s.folderId) {
      try {
        const f = await this.api("GET", `${DRIVE}/files/${this.s.folderId}?fields=id,name,trashed`);
        if (!f.trashed && f.name === this.s.folderName) return this.s.folderId;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
      this.s.folderId = "";
    }
    const name = this.s.folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false and 'root' in parents`;
    const found = await this.api(
      "GET",
      `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&orderBy=createdTime&spaces=drive`
    );
    if (found.files?.length) {
      this.s.folderId = found.files[0].id;
    } else {
      const created = await this.api("POST", `${DRIVE}/files?fields=id`, {
        name: this.s.folderName,
        mimeType: FOLDER_MIME,
        parents: ["root"],
      });
      this.s.folderId = created.id;
    }
    await this.save();
    return this.s.folderId;
  }

  async list(): Promise<Map<string, RemoteEntry>> {
    const folder = await this.ensureFolder();
    const out = new Map<string, RemoteEntry>();
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`);
    let pageToken = "";
    do {
      const page = await this.api(
        "GET",
        `${DRIVE}/files?q=${q}&pageSize=1000&orderBy=modifiedTime desc` +
          `&fields=nextPageToken,files(id,name,appProperties)` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
      );
      for (const f of page.files ?? []) {
        if (out.has(f.name)) continue; // duplicate from a race between devices: newest wins
        out.set(f.name, { path: f.name, hash: f.appProperties?.h ?? `unknown:${f.id}`, id: f.id });
      }
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    this.remote = out;
    return out;
  }

  async download(entry: RemoteEntry): Promise<ArrayBuffer> {
    const res = await http({
      url: `${DRIVE}/files/${entry.id}?alt=media`,
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
    return res.arrayBuffer;
  }

  async apply(uploads: Upload[], deletes: RemoteEntry[]): Promise<void> {
    const folder = await this.ensureFolder();
    await pool(uploads, 4, async (u) => {
      const existing = this.remote.get(u.path);
      const meta: Record<string, unknown> = { appProperties: { h: u.hash } };
      if (!existing) {
        meta.name = u.path;
        meta.parents = [folder];
      }
      const boundary = "cloudsync" + Math.random().toString(36).slice(2);
      const enc = new TextEncoder();
      const head = enc.encode(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
          `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
      );
      const tail = enc.encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.byteLength + u.data.byteLength + tail.byteLength);
      body.set(head, 0);
      body.set(new Uint8Array(u.data), head.byteLength);
      body.set(tail, head.byteLength + u.data.byteLength);
      const res = await http({
        url: existing
          ? `${UPLOAD}/files/${existing.id}?uploadType=multipart&fields=id`
          : `${UPLOAD}/files?uploadType=multipart&fields=id`,
        method: existing ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${await this.token()}` },
        contentType: `multipart/related; boundary=${boundary}`,
        body: body.buffer,
      });
      this.remote.set(u.path, { path: u.path, hash: u.hash, id: res.json.id });
    });
    // Deleted files go to the Drive trash, so they can be recovered for 30 days.
    await pool(deletes, 4, async (d) => {
      await this.api("PATCH", `${DRIVE}/files/${d.id}`, { trashed: true });
      this.remote.delete(d.path);
    });
  }
}

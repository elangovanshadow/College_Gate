import { requestUrl } from "obsidian";
import { Storage } from "megajs";
import { MegaSettings, RemoteEntry, SyncProvider, Upload } from "../types";
import { pool } from "../util";

/** Custom node attribute holding the file's content hash. Kept inside MEGA's encrypted attributes. */
const HASH_ATTR = "ocsh";

type MegaNode = any; // megajs' own typings reference Deno URLs, so we keep node handling untyped.

/**
 * fetch() replacement backed by Obsidian's requestUrl, which is not subject to CORS.
 * This is what lets MEGA work on Obsidian mobile as well as desktop.
 */
async function obsidianFetch(url: string | URL, opts: any = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (k.toLowerCase() !== "content-length") headers[k] = String(v);
  }
  let body = opts.body;
  if (body instanceof Uint8Array) body = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const res = await requestUrl({
    url: String(url),
    method: opts.method ?? "GET",
    headers,
    body,
    throw: false,
  });
  const empty = [101, 204, 205, 304].includes(res.status);
  return new Response(empty ? null : res.arrayBuffer, {
    status: res.status,
    statusText: `HTTP ${res.status}`,
    headers: res.headers,
  });
}

function apiOptions(email: string) {
  return { email, keepalive: false, autologin: false, autoload: false, userAgent: null, fetch: obsidianFetch as any };
}

function friendlyError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ESID|-15\b/.test(msg)) return new Error("MEGA: your session expired. Sign in again in the plugin settings.");
  if (/EOVERQUOTA|bandwidth|509|-17\b/i.test(msg)) {
    return new Error("MEGA: transfer quota reached (free accounts can download about 5 GB per day). Try again later.");
  }
  if (/ENOENT|-9\b/.test(msg)) return new Error("MEGA: wrong email or password.");
  if (/EMFAREQUIRED|-26\b/.test(msg)) return new Error("MEGA: this account uses two-factor authentication. Enter the 6-digit code.");
  return new Error(`MEGA: ${msg}`);
}

/** Logs in once and returns a reusable session. The password itself is never stored. */
export async function megaLogin(email: string, password: string, mfaCode?: string): Promise<MegaSettings["session"]> {
  try {
    const storage = new Storage({ ...apiOptions(email), password, secondFactorCode: mfaCode || undefined, autologin: true });
    await storage.ready;
    const json = storage.toJSON();
    return { key: json.key, sid: json.sid, name: json.name, user: json.user, email: email.toLowerCase() };
  } catch (e) {
    throw friendlyError(e);
  }
}

/**
 * Mirrors the vault as a normal folder tree inside one MEGA folder, so it is also browsable
 * in the MEGA app. MEGA encrypts everything client-side (end-to-end).
 */
export class MegaProvider implements SyncProvider {
  readonly name = "MEGA";
  private storage: any = null;
  private folders = new Map<string, MegaNode>();
  private files = new Map<string, MegaNode>();

  constructor(private s: MegaSettings) {}

  validate(): void {
    if (!this.s.session?.sid) throw new Error("MEGA: not signed in. Use 'Sign in to MEGA' in settings.");
    if (!this.s.folderName) throw new Error("MEGA: folder name is not set.");
  }

  private async open(): Promise<void> {
    if (this.storage) return;
    const sess = this.s.session!;
    const storage = Storage.fromJSON({
      key: sess.key,
      sid: sess.sid,
      name: sess.name,
      user: sess.user,
      options: apiOptions(sess.email) as any,
    });
    await storage.reload(true);
    this.storage = storage;
  }

  async close(): Promise<void> {
    if (!this.storage) return;
    try {
      this.storage.api.closed = true; // stop any pending polling without logging the session out
    } catch {
      /* ignore */
    }
    this.storage = null;
  }

  async list(): Promise<Map<string, RemoteEntry>> {
    try {
      await this.open();
      const root: MegaNode = this.storage.root;
      let base = (root.children ?? []).find((c: MegaNode) => c.directory && c.name === this.s.folderName);
      if (!base) base = await root.mkdir(this.s.folderName);

      this.folders = new Map([["", base]]);
      this.files = new Map();
      const out = new Map<string, RemoteEntry>();
      const walk = (node: MegaNode, prefix: string) => {
        for (const child of node.children ?? []) {
          const path = prefix ? `${prefix}/${child.name}` : child.name;
          if (child.directory) {
            this.folders.set(path, child);
            walk(child, path);
          } else {
            const existing = this.files.get(path);
            // Two files with the same name (e.g. a race between devices): the newest wins.
            if (existing && (existing.timestamp ?? 0) >= (child.timestamp ?? 0)) continue;
            this.files.set(path, child);
            out.set(path, { path, id: child.nodeId, hash: child.attributes?.[HASH_ATTR] ?? `unknown:${child.nodeId}` });
          }
        }
      };
      walk(base, "");
      return out;
    } catch (e) {
      throw friendlyError(e);
    }
  }

  async download(entry: RemoteEntry): Promise<ArrayBuffer> {
    try {
      const node = this.files.get(entry.path);
      if (!node) throw new Error(`file not found: ${entry.path}`);
      const buf: Uint8Array = await node.downloadBuffer({});
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch (e) {
      throw friendlyError(e);
    }
  }

  private async ensureFolder(path: string): Promise<MegaNode> {
    const found = this.folders.get(path);
    if (found) return found;
    const slash = path.lastIndexOf("/");
    const parent = await this.ensureFolder(slash < 0 ? "" : path.slice(0, slash));
    const created = await parent.mkdir(path.slice(slash + 1));
    this.folders.set(path, created);
    return created;
  }

  async apply(uploads: Upload[], deletes: RemoteEntry[]): Promise<void> {
    try {
      // Create folders one at a time first, so parallel uploads never create duplicates.
      for (const u of uploads) {
        const slash = u.path.lastIndexOf("/");
        await this.ensureFolder(slash < 0 ? "" : u.path.slice(0, slash));
      }
      await pool(uploads, 3, async (u) => {
        const slash = u.path.lastIndexOf("/");
        const parent = this.folders.get(slash < 0 ? "" : u.path.slice(0, slash));
        const name = u.path.slice(slash + 1);
        const old = this.files.get(u.path);
        const created = await parent.upload(
          { name, size: u.data.byteLength, attributes: { [HASH_ATTR]: u.hash } },
          new Uint8Array(u.data)
        ).complete;
        this.files.set(u.path, created);
        // MEGA can't replace file contents in place; remove the outdated copy permanently.
        if (old) await old.delete(true);
      });
      // Files deleted in the vault go to the MEGA rubbish bin, so they can be recovered.
      await pool(deletes, 3, async (d) => {
        const node = this.files.get(d.path);
        if (node) await node.delete(false);
        this.files.delete(d.path);
      });
    } catch (e) {
      throw friendlyError(e);
    }
  }
}

import { App, normalizePath } from "obsidian";
import { CloudSyncSettings, RemoteEntry, SyncProvider, Upload } from "./types";
import { compileExcludes, conflictPath, gitBlobSha, pool } from "./util";

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  skipped: string[];
}

export interface SyncOptions {
  pluginId: string;
  /** Asked before a sync that would delete a large share of files (guards against a misconfigured target). */
  confirmMassDelete: (where: "local" | "remote", count: number) => Promise<boolean>;
  onProgress?: (msg: string) => void;
}

/** Files that are device-specific and should never be synced. */
const ALWAYS_EXCLUDE = ["workspace.json", "workspace-mobile.json", "workspace", "cache"];

export class SyncEngine {
  constructor(
    private app: App,
    private settings: CloudSyncSettings,
    private provider: SyncProvider,
    private target: string,
    private opts: SyncOptions
  ) {}

  private get adapter() {
    return this.app.vault.adapter;
  }

  private isExcluded(path: string, matchers: ((p: string) => boolean)[]): boolean {
    const configDir = this.app.vault.configDir;
    if (path === configDir || path.startsWith(configDir + "/")) {
      if (!this.settings.syncConfigDir) return true;
      const rel = path.slice(configDir.length + 1);
      if (ALWAYS_EXCLUDE.includes(rel)) return true;
      // Never upload this plugin's own data.json — it contains your tokens.
      if (rel === `plugins/${this.opts.pluginId}/data.json`) return true;
    }
    return matchers.some((m) => m(path));
  }

  /** Walks the vault (including hidden folders) and returns path -> hash. */
  private async scanLocal(matchers: ((p: string) => boolean)[], skipped: string[]): Promise<Map<string, string>> {
    const files: string[] = [];
    const walk = async (dir: string) => {
      const listing = await this.adapter.list(dir);
      for (const f of listing.files) if (!this.isExcluded(f, matchers)) files.push(f);
      for (const d of listing.folders) if (!this.isExcluded(d, matchers)) await walk(d);
    };
    await walk("");

    const cache = this.settings.state.localCache;
    const out = new Map<string, string>();
    const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
    const seen = new Set<string>();
    await pool(files, 8, async (path) => {
      const stat = await this.adapter.stat(path);
      if (!stat || stat.type !== "file") return;
      if (stat.size > maxBytes) {
        skipped.push(path);
        return;
      }
      seen.add(path);
      const c = cache[path];
      if (c && c.mtime === stat.mtime && c.size === stat.size) {
        out.set(path, c.hash);
        return;
      }
      const hash = await gitBlobSha(await this.adapter.readBinary(path));
      cache[path] = { hash, mtime: stat.mtime, size: stat.size };
      out.set(path, hash);
    });
    for (const p of Object.keys(cache)) if (!seen.has(p)) delete cache[p];
    return out;
  }

  private async writeLocal(path: string, data: ArrayBuffer): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
    }
    await this.adapter.writeBinary(path, data);
    const stat = await this.adapter.stat(path);
    if (stat) this.settings.state.localCache[path] = { hash: await gitBlobSha(data), mtime: stat.mtime, size: stat.size };
  }

  async run(): Promise<SyncSummary> {
    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: [],
      skipped: [],
    };
    this.provider.validate();
    const state = this.settings.state;
    if (state.target !== this.target) {
      // New remote target: forget the old snapshot so nothing is deleted on the first sync.
      state.target = this.target;
      state.base = {};
    }
    const base = state.base;
    const matchers = compileExcludes(this.settings.excludePatterns);

    this.opts.onProgress?.("Scanning vault…");
    const local = await this.scanLocal(matchers, summary.skipped);
    this.opts.onProgress?.(`Listing ${this.provider.name}…`);
    const remote = await this.provider.list();
    for (const p of [...remote.keys()]) if (this.isExcluded(p, matchers)) remote.delete(p);

    const downloads: RemoteEntry[] = [];
    const uploads: string[] = [];
    const remoteDeletes: RemoteEntry[] = [];
    const localDeletes: string[] = [];
    const conflicts: string[] = [];

    const all = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
    for (const path of all) {
      const L = local.get(path);
      const R = remote.get(path)?.hash;
      const B = base[path];
      if (L === R) {
        if (L) base[path] = L;
        else delete base[path];
      } else if (L === B) {
        // Only the remote side changed.
        if (R) downloads.push(remote.get(path)!);
        else localDeletes.push(path);
      } else if (R === B) {
        // Only the local side changed.
        if (L) uploads.push(path);
        else remoteDeletes.push(remote.get(path)!);
      } else if (!L) {
        downloads.push(remote.get(path)!); // deleted here, edited there: keep the edit
      } else if (!R) {
        uploads.push(path); // deleted there, edited here: keep the edit
      } else {
        conflicts.push(path); // edited on both sides
      }
    }

    const tracked = Math.max(Object.keys(base).length, 1);
    const threshold = Math.max(10, tracked * 0.25);
    if (localDeletes.length > threshold && !(await this.opts.confirmMassDelete("local", localDeletes.length))) {
      throw new Error("Sync cancelled.");
    }
    if (remoteDeletes.length > threshold && !(await this.opts.confirmMassDelete("remote", remoteDeletes.length))) {
      throw new Error("Sync cancelled.");
    }

    // 1. Pull remote changes.
    let done = 0;
    await pool(downloads, 4, async (entry) => {
      this.opts.onProgress?.(`Downloading ${++done}/${downloads.length}`);
      const data = await this.provider.download(entry);
      await this.writeLocal(entry.path, data);
      base[entry.path] = entry.hash.startsWith("unknown:") ? await gitBlobSha(data) : entry.hash;
      summary.downloaded++;
    });

    // 2. Conflicts: keep the local version at the original path, save the remote one next to it.
    const uploadList: Upload[] = [];
    const device = this.settings.deviceName;
    for (const path of conflicts) {
      const data = await this.provider.download(remote.get(path)!);
      const cPath = normalizePath(conflictPath(path, "remote"));
      await this.writeLocal(cPath, data);
      uploadList.push({ path: cPath, hash: await gitBlobSha(data), data });
      uploads.push(path);
      summary.conflicts.push(path);
    }

    // 3. Push local changes.
    this.opts.onProgress?.(`Uploading ${uploads.length} file(s)…`);
    for (const path of uploads) {
      uploadList.push({ path, hash: local.get(path)!, data: await this.adapter.readBinary(path) });
    }
    if (uploadList.length || remoteDeletes.length) {
      const msg =
        `Vault sync${device ? ` from ${device}` : ""}: ` +
        `${uploadList.length} changed, ${remoteDeletes.length} deleted`;
      await this.provider.apply(uploadList, remoteDeletes, msg);
    }
    for (const u of uploadList) base[u.path] = u.hash;
    for (const d of remoteDeletes) delete base[d.path];
    summary.uploaded = uploadList.length;
    summary.deletedRemote = remoteDeletes.length;

    // 4. Apply remote deletions locally (moved to the vault's .trash folder, not destroyed).
    for (const path of localDeletes) {
      if (await this.adapter.exists(path)) await this.adapter.trashLocal(path);
      delete base[path];
      delete state.localCache[path];
      summary.deletedLocal++;
    }

    state.lastSync = Date.now();
    return summary;
  }
}

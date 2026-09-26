import { arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";
import { GitHubSettings, RemoteEntry, SyncProvider, Upload } from "../types";
import { HttpError, http, joinPath, pool } from "../util";

interface TreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string | null;
}

/**
 * Stores the vault in a GitHub repository using the Git Data API.
 * Every sync that changes something becomes a single commit, so history is preserved.
 */
export class GitHubProvider implements SyncProvider {
  readonly name = "GitHub";
  private headSha: string | null = null;
  private repoEmpty = false;

  constructor(private s: GitHubSettings) {}

  validate(): void {
    if (!this.s.token) throw new Error("GitHub: personal access token is not set.");
    if (!this.s.owner || !this.s.repo) throw new Error("GitHub: repository owner/name is not set.");
    if (!this.s.branch) throw new Error("GitHub: branch is not set.");
  }

  private get base(): string {
    return `https://api.github.com/repos/${encodeURIComponent(this.s.owner)}/${encodeURIComponent(this.s.repo)}`;
  }

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await http({
      url: `${this.base}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.s.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.status === 204 ? null : res.json;
  }

  private get prefix(): string {
    const root = joinPath(this.s.rootDir);
    return root ? root + "/" : "";
  }

  async list(): Promise<Map<string, RemoteEntry>> {
    const out = new Map<string, RemoteEntry>();
    this.headSha = null;
    this.repoEmpty = false;
    try {
      const ref = await this.api("GET", `/git/ref/heads/${this.s.branch}`);
      this.headSha = ref.object.sha;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        this.repoEmpty = true; // "Git Repository is empty."
        return out;
      }
      if (e instanceof HttpError && e.status === 404) {
        // Either the branch doesn't exist yet, or the repo/token is wrong. Check the repo.
        const repo = await this.api("GET", "");
        this.repoEmpty = repo.size === 0;
        return out;
      }
      throw e;
    }
    const commit = await this.api("GET", `/git/commits/${this.headSha}`);
    const tree = await this.api("GET", `/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) {
      throw new Error("GitHub: repository tree is too large to list in one request (over ~100k files).");
    }
    const prefix = this.prefix;
    for (const item of tree.tree as TreeItem[]) {
      if (item.type !== "blob" || item.mode === "120000" || !item.sha) continue;
      if (prefix && !item.path.startsWith(prefix)) continue;
      const path = item.path.slice(prefix.length);
      out.set(path, { path, hash: item.sha });
    }
    return out;
  }

  async download(entry: RemoteEntry): Promise<ArrayBuffer> {
    const blob = await this.api("GET", `/git/blobs/${entry.hash}`);
    return base64ToArrayBuffer((blob.content as string).replace(/\s/g, ""));
  }

  async apply(uploads: Upload[], deletes: RemoteEntry[], message: string): Promise<void> {
    if (uploads.length === 0 && deletes.length === 0) return;
    const prefix = this.prefix;

    if (this.repoEmpty) {
      // The Git Data API does not work on an empty repo; create the first file via the Contents API.
      const first = uploads.shift();
      if (!first) return;
      await this.api("PUT", `/contents/${encodePath(prefix + first.path)}`, {
        message,
        content: arrayBufferToBase64(first.data),
        branch: this.s.branch,
      });
      this.repoEmpty = false;
      const ref = await this.api("GET", `/git/ref/heads/${this.s.branch}`);
      this.headSha = ref.object.sha;
      if (uploads.length === 0 && deletes.length === 0) return;
    }

    const entries: TreeItem[] = [];
    await pool(uploads, 4, async (u) => {
      const blob = await this.api("POST", "/git/blobs", {
        content: arrayBufferToBase64(u.data),
        encoding: "base64",
      });
      entries.push({ path: prefix + u.path, mode: "100644", type: "blob", sha: blob.sha });
    });
    if (this.headSha) {
      for (const d of deletes) entries.push({ path: prefix + d.path, mode: "100644", type: "blob", sha: null });
    }

    let baseTree: string | undefined;
    if (this.headSha) {
      const head = await this.api("GET", `/git/commits/${this.headSha}`);
      baseTree = head.tree.sha;
    }
    const tree = await this.api("POST", "/git/trees", { base_tree: baseTree, tree: entries });
    const commit = await this.api("POST", "/git/commits", {
      message,
      tree: tree.sha,
      parents: this.headSha ? [this.headSha] : [],
    });

    if (this.headSha) {
      try {
        await this.api("PATCH", `/git/refs/heads/${this.s.branch}`, { sha: commit.sha, force: false });
      } catch (e) {
        if (e instanceof HttpError && e.status === 422) {
          throw new Error("GitHub: the branch changed while syncing (another device pushed). Sync again.");
        }
        throw e;
      }
    } else {
      await this.api("POST", "/git/refs", { ref: `refs/heads/${this.s.branch}`, sha: commit.sha });
    }
    this.headSha = commit.sha;
  }
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

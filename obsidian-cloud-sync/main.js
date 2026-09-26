var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => CloudSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian6 = require("obsidian");

// src/providers/gdrive.ts
var import_obsidian2 = require("obsidian");

// src/util.ts
var import_obsidian = require("obsidian");
var encoder = new TextEncoder();
async function gitBlobSha(data) {
  const header = encoder.encode(`blob ${data.byteLength}\0`);
  const buf = new Uint8Array(header.byteLength + data.byteLength);
  buf.set(header, 0);
  buf.set(new Uint8Array(data), header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
var HttpError = class extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
};
async function http(params) {
  var _a, _b, _c, _d;
  const res = await (0, import_obsidian.requestUrl)({ ...params, throw: false });
  if (res.status >= 400) {
    let detail = "";
    try {
      const j = res.json;
      detail = (j == null ? void 0 : j.message) || (j == null ? void 0 : j.error_description) || ((_a = j == null ? void 0 : j.error) == null ? void 0 : _a.message) || JSON.stringify(j);
    } catch (e) {
      detail = (_c = (_b = res.text) == null ? void 0 : _b.slice(0, 300)) != null ? _c : "";
    }
    throw new HttpError(res.status, `HTTP ${res.status} ${(_d = params.method) != null ? _d : "GET"} ${params.url}: ${detail}`, res.text);
  }
  return res;
}
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
function compileExcludes(patterns) {
  return patterns.split("\n").map((p) => p.trim().replace(/^\/+|\/+$/g, "")).filter((p) => p && !p.startsWith("#")).map((p) => {
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*" && p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else if (c === "*")
        re += "[^/]*";
      else if (c === "?")
        re += "[^/]";
      else
        re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    const full = new RegExp(`^${re}(?:/.*)?$`);
    return (path) => full.test(path);
  });
}
function joinPath(...parts) {
  return parts.filter((p) => p).join("/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
function conflictPath(path, device) {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const tag = `conflict ${device ? device + " " : ""}${stamp}`.replace(/[\\/:*?"<>|]/g, "-");
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot > slash + 1)
    return `${path.slice(0, dot)} (${tag})${path.slice(dot)}`;
  return `${path} (${tag})`;
}

// src/providers/gdrive.ts
var DRIVE = "https://www.googleapis.com/drive/v3";
var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
var TOKEN_URL = "https://oauth2.googleapis.com/token";
var DEVICE_URL = "https://oauth2.googleapis.com/device/code";
var SCOPE = "https://www.googleapis.com/auth/drive.file";
var FOLDER_MIME = "application/vnd.google-apps.folder";
function form(data) {
  return Object.entries(data).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
async function startDeviceFlow(clientId) {
  const res = await http({
    url: DEVICE_URL,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: form({ client_id: clientId, scope: SCOPE })
  });
  return res.json;
}
async function pollDeviceFlow(s, code, isCancelled) {
  let interval = Math.max(code.interval, 5) * 1e3;
  const deadline = Date.now() + code.expires_in * 1e3;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    if (isCancelled())
      throw new Error("Cancelled.");
    const res = await (0, import_obsidian2.requestUrl)({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        client_id: s.clientId,
        client_secret: s.clientSecret,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      }),
      throw: false
    });
    const j = res.json;
    if (res.status < 400 && j.refresh_token) {
      return { refreshToken: j.refresh_token, accessToken: j.access_token, expiresIn: j.expires_in };
    }
    if ((j == null ? void 0 : j.error) === "authorization_pending")
      continue;
    if ((j == null ? void 0 : j.error) === "slow_down") {
      interval += 5e3;
      continue;
    }
    throw new Error(`Google sign-in failed: ${(j == null ? void 0 : j.error_description) || (j == null ? void 0 : j.error) || res.status}`);
  }
  throw new Error("Google sign-in timed out. Try again.");
}
var GDriveProvider = class {
  constructor(s, save) {
    this.s = s;
    this.save = save;
    this.name = "Google Drive";
    this.remote = /* @__PURE__ */ new Map();
  }
  validate() {
    if (!this.s.clientId || !this.s.clientSecret)
      throw new Error("Google Drive: OAuth client ID/secret is not set.");
    if (!this.s.refreshToken)
      throw new Error("Google Drive: not signed in. Use 'Sign in with Google' in settings.");
    if (!this.s.folderName)
      throw new Error("Google Drive: folder name is not set.");
  }
  async token() {
    if (this.s.accessToken && Date.now() < this.s.accessTokenExpiry - 6e4)
      return this.s.accessToken;
    const res = await http({
      url: TOKEN_URL,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: form({
        client_id: this.s.clientId,
        client_secret: this.s.clientSecret,
        refresh_token: this.s.refreshToken,
        grant_type: "refresh_token"
      })
    });
    this.s.accessToken = res.json.access_token;
    this.s.accessTokenExpiry = Date.now() + res.json.expires_in * 1e3;
    await this.save();
    return this.s.accessToken;
  }
  async api(method, url, body) {
    const res = await http({
      url,
      method,
      headers: { Authorization: `Bearer ${await this.token()}` },
      contentType: body ? "application/json" : void 0,
      body: body ? JSON.stringify(body) : void 0
    });
    return res.status === 204 || !res.text ? null : res.json;
  }
  async ensureFolder() {
    var _a;
    if (this.s.folderId) {
      try {
        const f = await this.api("GET", `${DRIVE}/files/${this.s.folderId}?fields=id,name,trashed`);
        if (!f.trashed && f.name === this.s.folderName)
          return this.s.folderId;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404))
          throw e;
      }
      this.s.folderId = "";
    }
    const name = this.s.folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false and 'root' in parents`;
    const found = await this.api(
      "GET",
      `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&orderBy=createdTime&spaces=drive`
    );
    if ((_a = found.files) == null ? void 0 : _a.length) {
      this.s.folderId = found.files[0].id;
    } else {
      const created = await this.api("POST", `${DRIVE}/files?fields=id`, {
        name: this.s.folderName,
        mimeType: FOLDER_MIME,
        parents: ["root"]
      });
      this.s.folderId = created.id;
    }
    await this.save();
    return this.s.folderId;
  }
  async list() {
    var _a, _b, _c, _d;
    const folder = await this.ensureFolder();
    const out = /* @__PURE__ */ new Map();
    const q = encodeURIComponent(`'${folder}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`);
    let pageToken = "";
    do {
      const page = await this.api(
        "GET",
        `${DRIVE}/files?q=${q}&pageSize=1000&orderBy=modifiedTime desc&fields=nextPageToken,files(id,name,appProperties)` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "")
      );
      for (const f of (_a = page.files) != null ? _a : []) {
        if (out.has(f.name))
          continue;
        out.set(f.name, { path: f.name, hash: (_c = (_b = f.appProperties) == null ? void 0 : _b.h) != null ? _c : `unknown:${f.id}`, id: f.id });
      }
      pageToken = (_d = page.nextPageToken) != null ? _d : "";
    } while (pageToken);
    this.remote = out;
    return out;
  }
  async download(entry) {
    const res = await http({
      url: `${DRIVE}/files/${entry.id}?alt=media`,
      headers: { Authorization: `Bearer ${await this.token()}` }
    });
    return res.arrayBuffer;
  }
  async apply(uploads, deletes) {
    const folder = await this.ensureFolder();
    await pool(uploads, 4, async (u) => {
      const existing = this.remote.get(u.path);
      const meta = { appProperties: { h: u.hash } };
      if (!existing) {
        meta.name = u.path;
        meta.parents = [folder];
      }
      const boundary = "cloudsync" + Math.random().toString(36).slice(2);
      const enc = new TextEncoder();
      const head = enc.encode(
        `--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(meta)}\r
--${boundary}\r
Content-Type: application/octet-stream\r
\r
`
      );
      const tail = enc.encode(`\r
--${boundary}--`);
      const body = new Uint8Array(head.byteLength + u.data.byteLength + tail.byteLength);
      body.set(head, 0);
      body.set(new Uint8Array(u.data), head.byteLength);
      body.set(tail, head.byteLength + u.data.byteLength);
      const res = await http({
        url: existing ? `${UPLOAD}/files/${existing.id}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`,
        method: existing ? "PATCH" : "POST",
        headers: { Authorization: `Bearer ${await this.token()}` },
        contentType: `multipart/related; boundary=${boundary}`,
        body: body.buffer
      });
      this.remote.set(u.path, { path: u.path, hash: u.hash, id: res.json.id });
    });
    await pool(deletes, 4, async (d) => {
      await this.api("PATCH", `${DRIVE}/files/${d.id}`, { trashed: true });
      this.remote.delete(d.path);
    });
  }
};

// src/providers/github.ts
var import_obsidian3 = require("obsidian");
var GitHubProvider = class {
  constructor(s) {
    this.s = s;
    this.name = "GitHub";
    this.headSha = null;
    this.repoEmpty = false;
  }
  validate() {
    if (!this.s.token)
      throw new Error("GitHub: personal access token is not set.");
    if (!this.s.owner || !this.s.repo)
      throw new Error("GitHub: repository owner/name is not set.");
    if (!this.s.branch)
      throw new Error("GitHub: branch is not set.");
  }
  get base() {
    return `https://api.github.com/repos/${encodeURIComponent(this.s.owner)}/${encodeURIComponent(this.s.repo)}`;
  }
  async api(method, path, body) {
    const res = await http({
      url: `${this.base}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.s.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...body ? { "Content-Type": "application/json" } : {}
      },
      body: body ? JSON.stringify(body) : void 0
    });
    return res.status === 204 ? null : res.json;
  }
  get prefix() {
    const root = joinPath(this.s.rootDir);
    return root ? root + "/" : "";
  }
  async list() {
    const out = /* @__PURE__ */ new Map();
    this.headSha = null;
    this.repoEmpty = false;
    try {
      const ref = await this.api("GET", `/git/ref/heads/${this.s.branch}`);
      this.headSha = ref.object.sha;
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) {
        this.repoEmpty = true;
        return out;
      }
      if (e instanceof HttpError && e.status === 404) {
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
    for (const item of tree.tree) {
      if (item.type !== "blob" || item.mode === "120000" || !item.sha)
        continue;
      if (prefix && !item.path.startsWith(prefix))
        continue;
      const path = item.path.slice(prefix.length);
      out.set(path, { path, hash: item.sha });
    }
    return out;
  }
  async download(entry) {
    const blob = await this.api("GET", `/git/blobs/${entry.hash}`);
    return (0, import_obsidian3.base64ToArrayBuffer)(blob.content.replace(/\s/g, ""));
  }
  async apply(uploads, deletes, message) {
    if (uploads.length === 0 && deletes.length === 0)
      return;
    const prefix = this.prefix;
    if (this.repoEmpty) {
      const first = uploads.shift();
      if (!first)
        return;
      await this.api("PUT", `/contents/${encodePath(prefix + first.path)}`, {
        message,
        content: (0, import_obsidian3.arrayBufferToBase64)(first.data),
        branch: this.s.branch
      });
      this.repoEmpty = false;
      const ref = await this.api("GET", `/git/ref/heads/${this.s.branch}`);
      this.headSha = ref.object.sha;
      if (uploads.length === 0 && deletes.length === 0)
        return;
    }
    const entries = [];
    await pool(uploads, 4, async (u) => {
      const blob = await this.api("POST", "/git/blobs", {
        content: (0, import_obsidian3.arrayBufferToBase64)(u.data),
        encoding: "base64"
      });
      entries.push({ path: prefix + u.path, mode: "100644", type: "blob", sha: blob.sha });
    });
    if (this.headSha) {
      for (const d of deletes)
        entries.push({ path: prefix + d.path, mode: "100644", type: "blob", sha: null });
    }
    let baseTree;
    if (this.headSha) {
      const head = await this.api("GET", `/git/commits/${this.headSha}`);
      baseTree = head.tree.sha;
    }
    const tree = await this.api("POST", "/git/trees", { base_tree: baseTree, tree: entries });
    const commit = await this.api("POST", "/git/commits", {
      message,
      tree: tree.sha,
      parents: this.headSha ? [this.headSha] : []
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
};
function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

// src/settings.ts
var import_obsidian4 = require("obsidian");
var CloudSyncSettingTab = class extends import_obsidian4.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();
    new import_obsidian4.Setting(containerEl).setName("Sync with").setDesc("Where your vault is stored. Use the same settings on every device.").addDropdown(
      (d) => d.addOption("github", "GitHub repository").addOption("gdrive", "Google Drive").setValue(s.provider).onChange(async (v) => {
        s.provider = v;
        await save();
        this.display();
      })
    );
    if (s.provider === "github")
      this.displayGitHub(containerEl);
    else
      this.displayGDrive(containerEl);
    new import_obsidian4.Setting(containerEl).setName("General").setHeading();
    new import_obsidian4.Setting(containerEl).setName("Device name").setDesc("Shown in GitHub commit messages.").addText((t) => t.setValue(s.deviceName).onChange(async (v) => (s.deviceName = v.trim(), await save())));
    new import_obsidian4.Setting(containerEl).setName("Sync on startup").addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => (s.syncOnStartup = v, await save())));
    new import_obsidian4.Setting(containerEl).setName("Auto-sync interval (minutes)").setDesc("0 disables automatic syncing.").addText(
      (t) => t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) {
          s.autoSyncMinutes = n;
          await save();
          this.plugin.scheduleAutoSync();
        }
      })
    );
    new import_obsidian4.Setting(containerEl).setName(`Sync settings folder (${this.app.vault.configDir})`).setDesc("Also sync themes, plugins and settings. Workspace layout and this plugin's tokens are never synced.").addToggle((t) => t.setValue(s.syncConfigDir).onChange(async (v) => (s.syncConfigDir = v, await save())));
    new import_obsidian4.Setting(containerEl).setName("Excluded paths").setDesc("One pattern per line. * matches within a folder, ** across folders. A folder name excludes its contents.").addTextArea((t) => {
      t.setValue(s.excludePatterns).onChange(async (v) => (s.excludePatterns = v, await save()));
      t.inputEl.rows = 5;
    });
    new import_obsidian4.Setting(containerEl).setName("Max file size (MB)").setDesc("Larger files are skipped. GitHub rejects files over 100 MB.").addText(
      (t) => t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0)
          s.maxFileSizeMB = n, await save();
      })
    );
    new import_obsidian4.Setting(containerEl).setName("Show notifications").addToggle((t) => t.setValue(s.showNotices).onChange(async (v) => (s.showNotices = v, await save())));
    new import_obsidian4.Setting(containerEl).setName("Reset sync state").setDesc(
      "Forget what was synced last time. The next sync then only adds and updates files (never deletes); files that differ on both sides are kept as conflict copies."
    ).addButton(
      (b) => b.setButtonText("Reset").onClick(async () => {
        s.state = { target: "", base: {}, localCache: {}, lastSync: 0 };
        await save();
        new import_obsidian4.Notice("Cloud Sync: sync state reset.");
      })
    );
    new import_obsidian4.Setting(containerEl).addButton(
      (b) => b.setButtonText("Sync now").setCta().onClick(() => this.plugin.sync())
    );
  }
  displayGitHub(el) {
    const g = this.plugin.settings.github;
    const save = () => this.plugin.saveSettings();
    new import_obsidian4.Setting(el).setName("GitHub").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text: "Create a private repository, then a fine-grained personal access token at GitHub \u2192 Settings \u2192 Developer settings \u2192 Personal access tokens, with access to only that repository and the permission \u201CContents: Read and write\u201D."
    });
    new import_obsidian4.Setting(el).setName("Personal access token").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("github_pat_\u2026").setValue(g.token).onChange(async (v) => (g.token = v.trim(), await save()));
    });
    new import_obsidian4.Setting(el).setName("Repository owner").setDesc("Your GitHub username or organization.").addText((t) => t.setValue(g.owner).onChange(async (v) => (g.owner = v.trim(), await save())));
    new import_obsidian4.Setting(el).setName("Repository name").addText((t) => t.setPlaceholder("my-vault").setValue(g.repo).onChange(async (v) => (g.repo = v.trim(), await save())));
    new import_obsidian4.Setting(el).setName("Branch").addText((t) => t.setValue(g.branch).onChange(async (v) => (g.branch = v.trim(), await save())));
    new import_obsidian4.Setting(el).setName("Folder in repository").setDesc("Optional. Leave empty to store the vault at the repository root.").addText((t) => t.setValue(g.rootDir).onChange(async (v) => (g.rootDir = v.trim(), await save())));
    this.addTestButton(el);
  }
  displayGDrive(el) {
    const g = this.plugin.settings.gdrive;
    const save = () => this.plugin.saveSettings();
    new import_obsidian4.Setting(el).setName("Google Drive").setHeading();
    const help = el.createEl("div", { cls: "setting-item-description" });
    help.createEl("p", { text: "One-time setup (about 5 minutes) \u2014 you create your own Google OAuth client so no third party can access your data:" });
    const ol = help.createEl("ol");
    ol.createEl("li", { text: "Open console.cloud.google.com, create a project, and enable the \u201CGoogle Drive API\u201D." });
    ol.createEl("li", { text: "OAuth consent screen: choose External, add yourself as a test user (or publish the app)." });
    ol.createEl("li", { text: "Credentials \u2192 Create credentials \u2192 OAuth client ID \u2192 Application type \u201CTVs and Limited Input devices\u201D." });
    ol.createEl("li", { text: "Paste the client ID and secret below, then click \u201CSign in with Google\u201D. Repeat the sign-in on each device." });
    new import_obsidian4.Setting(el).setName("OAuth client ID").addText((t) => t.setValue(g.clientId).onChange(async (v) => (g.clientId = v.trim(), await save())));
    new import_obsidian4.Setting(el).setName("OAuth client secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(g.clientSecret).onChange(async (v) => (g.clientSecret = v.trim(), await save()));
    });
    new import_obsidian4.Setting(el).setName("Drive folder name").setDesc("Folder in \u201CMy Drive\u201D that stores the vault. Created automatically.").addText(
      (t) => t.setValue(g.folderName).onChange(async (v) => {
        g.folderName = v.trim();
        g.folderId = "";
        await save();
      })
    );
    new import_obsidian4.Setting(el).setName("Account").setDesc(g.refreshToken ? "Signed in \u2714" : "Not signed in").addButton(
      (b) => b.setButtonText(g.refreshToken ? "Sign in again" : "Sign in with Google").setCta().onClick(async () => {
        if (!g.clientId || !g.clientSecret) {
          new import_obsidian4.Notice("Enter the OAuth client ID and secret first.");
          return;
        }
        try {
          const code = await startDeviceFlow(g.clientId);
          new GoogleSignInModal(this.app, code, async (cancelled) => {
            const t = await pollDeviceFlow(g, code, cancelled);
            g.refreshToken = t.refreshToken;
            g.accessToken = t.accessToken;
            g.accessTokenExpiry = Date.now() + t.expiresIn * 1e3;
            await save();
            new import_obsidian4.Notice("Cloud Sync: signed in to Google Drive.");
            this.display();
          }).open();
        } catch (e) {
          new import_obsidian4.Notice(`Google sign-in failed: ${e instanceof Error ? e.message : e}`, 1e4);
        }
      })
    ).addButton(
      (b) => b.setButtonText("Sign out").onClick(async () => {
        g.refreshToken = "";
        g.accessToken = "";
        g.accessTokenExpiry = 0;
        await save();
        this.display();
      })
    );
    this.addTestButton(el);
  }
  addTestButton(el) {
    new import_obsidian4.Setting(el).setName("Test connection").addButton(
      (b) => b.setButtonText("Test").onClick(async () => {
        try {
          const p = this.plugin.createProvider();
          p.validate();
          const files = await p.list();
          new import_obsidian4.Notice(`Connected to ${p.name}. ${files.size} file(s) stored remotely.`);
        } catch (e) {
          new import_obsidian4.Notice(`Connection failed: ${e instanceof Error ? e.message : e}`, 1e4);
        }
      })
    );
  }
};
var GoogleSignInModal = class extends import_obsidian4.Modal {
  constructor(app, code, run) {
    super(app);
    this.code = code;
    this.run = run;
    this.cancelled = false;
  }
  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("Sign in with Google");
    contentEl.createEl("p", { text: "1. Open this link (on any device):" });
    const link = contentEl.createEl("a", { text: this.code.verification_url, href: this.code.verification_url });
    link.setAttr("target", "_blank");
    contentEl.createEl("p", { text: "2. Enter this code:" });
    const codeEl = contentEl.createEl("div", { text: this.code.user_code });
    codeEl.style.fontSize = "1.8em";
    codeEl.style.fontWeight = "bold";
    codeEl.style.letterSpacing = "0.1em";
    codeEl.style.userSelect = "text";
    new import_obsidian4.Setting(contentEl).addButton(
      (b) => b.setButtonText("Copy code").onClick(() => navigator.clipboard.writeText(this.code.user_code))
    );
    const status = contentEl.createEl("p", { text: "Waiting for approval\u2026", cls: "setting-item-description" });
    this.run(() => this.cancelled).then(() => this.close()).catch((e) => {
      if (!this.cancelled)
        status.setText(`Failed: ${e instanceof Error ? e.message : e}`);
    });
  }
  onClose() {
    this.cancelled = true;
    this.contentEl.empty();
  }
};

// src/sync.ts
var import_obsidian5 = require("obsidian");
var ALWAYS_EXCLUDE = ["workspace.json", "workspace-mobile.json", "workspace", "cache"];
var SyncEngine = class {
  constructor(app, settings, provider, target, opts) {
    this.app = app;
    this.settings = settings;
    this.provider = provider;
    this.target = target;
    this.opts = opts;
  }
  get adapter() {
    return this.app.vault.adapter;
  }
  isExcluded(path, matchers) {
    const configDir = this.app.vault.configDir;
    if (path === configDir || path.startsWith(configDir + "/")) {
      if (!this.settings.syncConfigDir)
        return true;
      const rel = path.slice(configDir.length + 1);
      if (ALWAYS_EXCLUDE.includes(rel))
        return true;
      if (rel === `plugins/${this.opts.pluginId}/data.json`)
        return true;
    }
    return matchers.some((m) => m(path));
  }
  /** Walks the vault (including hidden folders) and returns path -> hash. */
  async scanLocal(matchers, skipped) {
    const files = [];
    const walk = async (dir) => {
      const listing = await this.adapter.list(dir);
      for (const f of listing.files)
        if (!this.isExcluded(f, matchers))
          files.push(f);
      for (const d of listing.folders)
        if (!this.isExcluded(d, matchers))
          await walk(d);
    };
    await walk("");
    const cache = this.settings.state.localCache;
    const out = /* @__PURE__ */ new Map();
    const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
    const seen = /* @__PURE__ */ new Set();
    await pool(files, 8, async (path) => {
      const stat = await this.adapter.stat(path);
      if (!stat || stat.type !== "file")
        return;
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
    for (const p of Object.keys(cache))
      if (!seen.has(p))
        delete cache[p];
    return out;
  }
  async writeLocal(path, data) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!await this.adapter.exists(dir))
        await this.adapter.mkdir(dir);
    }
    await this.adapter.writeBinary(path, data);
    const stat = await this.adapter.stat(path);
    if (stat)
      this.settings.state.localCache[path] = { hash: await gitBlobSha(data), mtime: stat.mtime, size: stat.size };
  }
  async run() {
    var _a, _b, _c, _d, _e, _f, _g;
    const summary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: [],
      skipped: []
    };
    this.provider.validate();
    const state = this.settings.state;
    if (state.target !== this.target) {
      state.target = this.target;
      state.base = {};
    }
    const base = state.base;
    const matchers = compileExcludes(this.settings.excludePatterns);
    (_b = (_a = this.opts).onProgress) == null ? void 0 : _b.call(_a, "Scanning vault\u2026");
    const local = await this.scanLocal(matchers, summary.skipped);
    (_d = (_c = this.opts).onProgress) == null ? void 0 : _d.call(_c, `Listing ${this.provider.name}\u2026`);
    const remote = await this.provider.list();
    for (const p of [...remote.keys()])
      if (this.isExcluded(p, matchers))
        remote.delete(p);
    const downloads = [];
    const uploads = [];
    const remoteDeletes = [];
    const localDeletes = [];
    const conflicts = [];
    const all = /* @__PURE__ */ new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)]);
    for (const path of all) {
      const L = local.get(path);
      const R = (_e = remote.get(path)) == null ? void 0 : _e.hash;
      const B = base[path];
      if (L === R) {
        if (L)
          base[path] = L;
        else
          delete base[path];
      } else if (L === B) {
        if (R)
          downloads.push(remote.get(path));
        else
          localDeletes.push(path);
      } else if (R === B) {
        if (L)
          uploads.push(path);
        else
          remoteDeletes.push(remote.get(path));
      } else if (!L) {
        downloads.push(remote.get(path));
      } else if (!R) {
        uploads.push(path);
      } else {
        conflicts.push(path);
      }
    }
    const tracked = Math.max(Object.keys(base).length, 1);
    const threshold = Math.max(10, tracked * 0.25);
    if (localDeletes.length > threshold && !await this.opts.confirmMassDelete("local", localDeletes.length)) {
      throw new Error("Sync cancelled.");
    }
    if (remoteDeletes.length > threshold && !await this.opts.confirmMassDelete("remote", remoteDeletes.length)) {
      throw new Error("Sync cancelled.");
    }
    let done = 0;
    await pool(downloads, 4, async (entry) => {
      var _a2, _b2;
      (_b2 = (_a2 = this.opts).onProgress) == null ? void 0 : _b2.call(_a2, `Downloading ${++done}/${downloads.length}`);
      const data = await this.provider.download(entry);
      await this.writeLocal(entry.path, data);
      base[entry.path] = entry.hash.startsWith("unknown:") ? await gitBlobSha(data) : entry.hash;
      summary.downloaded++;
    });
    const uploadList = [];
    const device = this.settings.deviceName;
    for (const path of conflicts) {
      const data = await this.provider.download(remote.get(path));
      const cPath = (0, import_obsidian5.normalizePath)(conflictPath(path, "remote"));
      await this.writeLocal(cPath, data);
      uploadList.push({ path: cPath, hash: await gitBlobSha(data), data });
      uploads.push(path);
      summary.conflicts.push(path);
    }
    (_g = (_f = this.opts).onProgress) == null ? void 0 : _g.call(_f, `Uploading ${uploads.length} file(s)\u2026`);
    for (const path of uploads) {
      uploadList.push({ path, hash: local.get(path), data: await this.adapter.readBinary(path) });
    }
    if (uploadList.length || remoteDeletes.length) {
      const msg = `Vault sync${device ? ` from ${device}` : ""}: ${uploadList.length} changed, ${remoteDeletes.length} deleted`;
      await this.provider.apply(uploadList, remoteDeletes, msg);
    }
    for (const u of uploadList)
      base[u.path] = u.hash;
    for (const d of remoteDeletes)
      delete base[d.path];
    summary.uploaded = uploadList.length;
    summary.deletedRemote = remoteDeletes.length;
    for (const path of localDeletes) {
      if (await this.adapter.exists(path))
        await this.adapter.trashLocal(path);
      delete base[path];
      delete state.localCache[path];
      summary.deletedLocal++;
    }
    state.lastSync = Date.now();
    return summary;
  }
};

// src/types.ts
var DEFAULT_SETTINGS = {
  provider: "github",
  github: { token: "", owner: "", repo: "", branch: "main", rootDir: "" },
  gdrive: {
    clientId: "",
    clientSecret: "",
    refreshToken: "",
    accessToken: "",
    accessTokenExpiry: 0,
    folderName: "Obsidian Cloud Sync",
    folderId: ""
  },
  deviceName: "",
  syncOnStartup: true,
  autoSyncMinutes: 10,
  syncConfigDir: false,
  excludePatterns: ".trash/\n.git/\n**/.DS_Store",
  maxFileSizeMB: 50,
  showNotices: true,
  state: { target: "", base: {}, localCache: {}, lastSync: 0 }
};

// src/main.ts
var CloudSyncPlugin = class extends import_obsidian6.Plugin {
  constructor() {
    super(...arguments);
    this.syncing = false;
    this.intervalId = null;
  }
  async onload() {
    await this.loadSettings();
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.onClickEvent(() => this.sync());
    this.updateStatus();
    this.addRibbonIcon("refresh-cw", "Cloud Sync: sync now", () => this.sync());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync() });
    this.addSettingTab(new CloudSyncSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.syncOnStartup && this.isConfigured()) {
        window.setTimeout(() => this.sync(true), 3e3);
      }
    });
    this.scheduleAutoSync();
  }
  onunload() {
    if (this.intervalId !== null)
      window.clearInterval(this.intervalId);
  }
  async loadSettings() {
    var _a;
    const data = (_a = await this.loadData()) != null ? _a : {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      github: { ...DEFAULT_SETTINGS.github, ...data.github },
      gdrive: { ...DEFAULT_SETTINGS.gdrive, ...data.gdrive },
      state: { ...DEFAULT_SETTINGS.state, ...data.state }
    };
    if (!this.settings.deviceName) {
      this.settings.deviceName = import_obsidian6.Platform.isMobile ? "Mobile" : "Desktop";
    }
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  scheduleAutoSync() {
    if (this.intervalId !== null)
      window.clearInterval(this.intervalId);
    this.intervalId = null;
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.intervalId = window.setInterval(() => {
        if (this.isConfigured())
          this.sync(true);
      }, minutes * 6e4);
      this.registerInterval(this.intervalId);
    }
  }
  createProvider() {
    return this.settings.provider === "github" ? new GitHubProvider(this.settings.github) : new GDriveProvider(this.settings.gdrive, () => this.saveSettings());
  }
  targetKey() {
    const s = this.settings;
    return s.provider === "github" ? `github:${s.github.owner}/${s.github.repo}#${s.github.branch}:${s.github.rootDir}` : `gdrive:${s.gdrive.folderName}`;
  }
  isConfigured() {
    try {
      this.createProvider().validate();
      return true;
    } catch (e) {
      return false;
    }
  }
  updateStatus(text) {
    if (text) {
      this.statusBar.setText(`\u2601 ${text}`);
      return;
    }
    const last = this.settings.state.lastSync;
    this.statusBar.setText(last ? `\u2601 Synced ${new Date(last).toLocaleTimeString()}` : "\u2601 Not synced");
  }
  /** @param background true for automatic syncs — only errors and changes are shown. */
  async sync(background = false) {
    if (this.syncing) {
      if (!background)
        new import_obsidian6.Notice("Cloud Sync: a sync is already running.");
      return;
    }
    this.syncing = true;
    const provider = this.createProvider();
    const engine = new SyncEngine(this.app, this.settings, provider, this.targetKey(), {
      pluginId: this.manifest.id,
      onProgress: (m) => this.updateStatus(m),
      confirmMassDelete: (where, count) => new ConfirmModal(
        this.app,
        `This sync would delete ${count} file(s) ${where === "local" ? "from this device" : `from ${provider.name}`}. This can happen if the sync target was changed or emptied. Continue?`
      ).ask()
    });
    try {
      if (!background && this.settings.showNotices)
        new import_obsidian6.Notice(`Cloud Sync: syncing with ${provider.name}\u2026`);
      const r = await engine.run();
      await this.saveSettings();
      const changed = r.uploaded + r.downloaded + r.deletedLocal + r.deletedRemote;
      if (this.settings.showNotices && (!background || changed > 0)) {
        new import_obsidian6.Notice(
          changed === 0 ? "Cloud Sync: everything is up to date." : `Cloud Sync: \u2191${r.uploaded} \u2193${r.downloaded} \u2715${r.deletedLocal + r.deletedRemote}`
        );
      }
      if (r.conflicts.length) {
        new import_obsidian6.Notice(
          `Cloud Sync: ${r.conflicts.length} conflict(s). The other device's version was saved as a "(conflict \u2026)" copy:
` + r.conflicts.slice(0, 5).join("\n"),
          15e3
        );
      }
      if (r.skipped.length && !background) {
        new import_obsidian6.Notice(`Cloud Sync: skipped ${r.skipped.length} file(s) larger than ${this.settings.maxFileSizeMB} MB.`);
      }
      this.updateStatus();
    } catch (e) {
      console.error("Cloud Sync error", e);
      await this.saveSettings();
      new import_obsidian6.Notice(`Cloud Sync failed: ${e instanceof Error ? e.message : String(e)}`, 1e4);
      this.updateStatus("Sync failed");
    } finally {
      this.syncing = false;
    }
  }
};
var ConfirmModal = class extends import_obsidian6.Modal {
  constructor(app, message) {
    super(app);
    this.message = message;
    this.answered = false;
  }
  ask() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }
  onOpen() {
    this.titleEl.setText("Cloud Sync");
    this.contentEl.createEl("p", { text: this.message });
    new import_obsidian6.Setting(this.contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false))).addButton((b) => b.setButtonText("Continue").setWarning().onClick(() => this.finish(true)));
  }
  finish(v) {
    this.answered = true;
    this.resolve(v);
    this.close();
  }
  onClose() {
    if (!this.answered)
      this.resolve(false);
    this.contentEl.empty();
  }
};

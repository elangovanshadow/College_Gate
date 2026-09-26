import { App, Modal, Notice, Platform, Plugin, Setting } from "obsidian";
import { GDriveProvider } from "./providers/gdrive";
import { GitHubProvider } from "./providers/github";
import { MegaProvider } from "./providers/mega";
import { CloudSyncSettingTab } from "./settings";
import { SyncEngine } from "./sync";
import { CloudSyncSettings, DEFAULT_SETTINGS, SyncProvider } from "./types";

export default class CloudSyncPlugin extends Plugin {
  settings!: CloudSyncSettings;
  private statusBar!: HTMLElement;
  private syncing = false;
  private intervalId: number | null = null;

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
        window.setTimeout(() => this.sync(true), 3000);
      }
    });
    this.scheduleAutoSync();
  }

  onunload() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async loadSettings() {
    const data = (await this.loadData()) ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      github: { ...DEFAULT_SETTINGS.github, ...data.github },
      gdrive: { ...DEFAULT_SETTINGS.gdrive, ...data.gdrive },
      mega: { ...DEFAULT_SETTINGS.mega, ...data.mega },
      state: { ...DEFAULT_SETTINGS.state, ...data.state },
    };
    if (!this.settings.deviceName) {
      this.settings.deviceName = Platform.isMobile ? "Mobile" : "Desktop";
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  scheduleAutoSync() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.intervalId = window.setInterval(() => {
        if (this.isConfigured()) this.sync(true);
      }, minutes * 60_000);
      this.registerInterval(this.intervalId);
    }
  }

  createProvider(): SyncProvider {
    switch (this.settings.provider) {
      case "github":
        return new GitHubProvider(this.settings.github);
      case "mega":
        return new MegaProvider(this.settings.mega);
      default:
        return new GDriveProvider(this.settings.gdrive, () => this.saveSettings());
    }
  }

  private targetKey(): string {
    const s = this.settings;
    switch (s.provider) {
      case "github":
        return `github:${s.github.owner}/${s.github.repo}#${s.github.branch}:${s.github.rootDir}`;
      case "mega":
        return `mega:${s.mega.session?.email ?? ""}:${s.mega.folderName}`;
      default:
        return `gdrive:${s.gdrive.folderName}`;
    }
  }

  isConfigured(): boolean {
    try {
      this.createProvider().validate();
      return true;
    } catch {
      return false;
    }
  }

  private updateStatus(text?: string) {
    if (text) {
      this.statusBar.setText(`☁ ${text}`);
      return;
    }
    const last = this.settings.state.lastSync;
    this.statusBar.setText(last ? `☁ Synced ${new Date(last).toLocaleTimeString()}` : "☁ Not synced");
  }

  /** @param background true for automatic syncs — only errors and changes are shown. */
  async sync(background = false) {
    if (this.syncing) {
      if (!background) new Notice("Cloud Sync: a sync is already running.");
      return;
    }
    this.syncing = true;
    const provider = this.createProvider();
    const engine = new SyncEngine(this.app, this.settings, provider, this.targetKey(), {
      pluginId: this.manifest.id,
      onProgress: (m) => this.updateStatus(m),
      confirmMassDelete: (where, count) =>
        new ConfirmModal(
          this.app,
          `This sync would delete ${count} file(s) ${where === "local" ? "from this device" : `from ${provider.name}`}. ` +
            "This can happen if the sync target was changed or emptied. Continue?"
        ).ask(),
    });
    try {
      if (!background && this.settings.showNotices) new Notice(`Cloud Sync: syncing with ${provider.name}…`);
      const r = await engine.run();
      await this.saveSettings();
      const changed = r.uploaded + r.downloaded + r.deletedLocal + r.deletedRemote;
      if (this.settings.showNotices && (!background || changed > 0)) {
        new Notice(
          changed === 0
            ? "Cloud Sync: everything is up to date."
            : `Cloud Sync: ↑${r.uploaded} ↓${r.downloaded} ✕${r.deletedLocal + r.deletedRemote}`
        );
      }
      if (r.conflicts.length) {
        new Notice(
          `Cloud Sync: ${r.conflicts.length} conflict(s). The other device's version was saved as a "(conflict …)" copy:\n` +
            r.conflicts.slice(0, 5).join("\n"),
          15000
        );
      }
      if (r.skipped.length && !background) {
        new Notice(`Cloud Sync: skipped ${r.skipped.length} file(s) larger than ${this.settings.maxFileSizeMB} MB.`);
      }
      this.updateStatus();
    } catch (e) {
      console.error("Cloud Sync error", e);
      await this.saveSettings(); // keep the hash cache / partial progress
      new Notice(`Cloud Sync failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
      this.updateStatus("Sync failed");
    } finally {
      this.syncing = false;
    }
  }
}

class ConfirmModal extends Modal {
  private resolve!: (v: boolean) => void;
  private answered = false;

  constructor(app: App, private message: string) {
    super(app);
  }

  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen() {
    this.titleEl.setText("Cloud Sync");
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
      .addButton((b) => b.setButtonText("Continue").setWarning().onClick(() => this.finish(true)));
  }

  private finish(v: boolean) {
    this.answered = true;
    this.resolve(v);
    this.close();
  }

  onClose() {
    if (!this.answered) this.resolve(false);
    this.contentEl.empty();
  }
}

import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type CloudSyncPlugin from "./main";
import { pollDeviceFlow, startDeviceFlow } from "./providers/gdrive";
import { megaLogin } from "./providers/mega";
import { msPollDeviceFlow, msStartDeviceFlow } from "./providers/onedrive";
import { ProviderType } from "./types";

export class CloudSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CloudSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl)
      .setName("Sync with")
      .setDesc("Where your vault is stored. Use the same settings on every device.")
      .addDropdown((d) =>
        d
          .addOption("github", "GitHub repository")
          .addOption("gdrive", "Google Drive")
          .addOption("mega", "MEGA (20 GB free)")
          .addOption("onedrive", "OneDrive (Microsoft / school account)")
          .setValue(s.provider)
          .onChange(async (v) => {
            s.provider = v as ProviderType;
            await save();
            this.display();
          })
      );

    if (s.provider === "github") this.displayGitHub(containerEl);
    else if (s.provider === "mega") this.displayMega(containerEl);
    else if (s.provider === "onedrive") this.displayOneDrive(containerEl);
    else this.displayGDrive(containerEl);

    new Setting(containerEl).setName("General").setHeading();

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Shown in GitHub commit messages.")
      .addText((t) => t.setValue(s.deviceName).onChange(async (v) => ((s.deviceName = v.trim()), await save())));

    new Setting(containerEl)
      .setName("Sync on startup")
      .addToggle((t) => t.setValue(s.syncOnStartup).onChange(async (v) => ((s.syncOnStartup = v), await save())));

    new Setting(containerEl)
      .setName("Auto-sync interval (minutes)")
      .setDesc("0 disables automatic syncing.")
      .addText((t) =>
        t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) {
            s.autoSyncMinutes = n;
            await save();
            this.plugin.scheduleAutoSync();
          }
        })
      );

    new Setting(containerEl)
      .setName(`Sync settings folder (${this.app.vault.configDir})`)
      .setDesc("Also sync themes, plugins and settings. Workspace layout and this plugin's tokens are never synced.")
      .addToggle((t) => t.setValue(s.syncConfigDir).onChange(async (v) => ((s.syncConfigDir = v), await save())));

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("One pattern per line. * matches within a folder, ** across folders. A folder name excludes its contents.")
      .addTextArea((t) => {
        t.setValue(s.excludePatterns).onChange(async (v) => ((s.excludePatterns = v), await save()));
        t.inputEl.rows = 5;
      });

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Larger files are skipped. GitHub rejects files over 100 MB.")
      .addText((t) =>
        t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) ((s.maxFileSizeMB = n), await save());
        })
      );

    new Setting(containerEl)
      .setName("Show notifications")
      .addToggle((t) => t.setValue(s.showNotices).onChange(async (v) => ((s.showNotices = v), await save())));

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc(
        "Forget what was synced last time. The next sync then only adds and updates files (never deletes); " +
          "files that differ on both sides are kept as conflict copies."
      )
      .addButton((b) =>
        b.setButtonText("Reset").onClick(async () => {
          s.state = { target: "", base: {}, localCache: {}, lastSync: 0 };
          await save();
          new Notice("Cloud Sync: sync state reset.");
        })
      );

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Sync now")
        .setCta()
        .onClick(() => this.plugin.sync())
    );
  }

  private displayGitHub(el: HTMLElement) {
    const g = this.plugin.settings.github;
    const save = () => this.plugin.saveSettings();
    new Setting(el).setName("GitHub").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Create a private repository, then a fine-grained personal access token at " +
        "GitHub → Settings → Developer settings → Personal access tokens, with access to only that " +
        "repository and the permission “Contents: Read and write”.",
    });

    new Setting(el).setName("Personal access token").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("github_pat_…").setValue(g.token).onChange(async (v) => ((g.token = v.trim()), await save()));
    });
    new Setting(el)
      .setName("Repository owner")
      .setDesc("Your GitHub username or organization.")
      .addText((t) => t.setValue(g.owner).onChange(async (v) => ((g.owner = v.trim()), await save())));
    new Setting(el)
      .setName("Repository name")
      .addText((t) => t.setPlaceholder("my-vault").setValue(g.repo).onChange(async (v) => ((g.repo = v.trim()), await save())));
    new Setting(el)
      .setName("Branch")
      .addText((t) => t.setValue(g.branch).onChange(async (v) => ((g.branch = v.trim()), await save())));
    new Setting(el)
      .setName("Folder in repository")
      .setDesc("Optional. Leave empty to store the vault at the repository root.")
      .addText((t) => t.setValue(g.rootDir).onChange(async (v) => ((g.rootDir = v.trim()), await save())));
    this.addTestButton(el);
  }

  private displayGDrive(el: HTMLElement) {
    const g = this.plugin.settings.gdrive;
    const save = () => this.plugin.saveSettings();
    new Setting(el).setName("Google Drive").setHeading();
    const help = el.createEl("div", { cls: "setting-item-description" });
    help.createEl("p", { text: "One-time setup (about 5 minutes) — you create your own Google OAuth client so no third party can access your data:" });
    const ol = help.createEl("ol");
    ol.createEl("li", { text: "Open console.cloud.google.com, create a project, and enable the “Google Drive API”." });
    ol.createEl("li", { text: "OAuth consent screen: choose External, add yourself as a test user (or publish the app)." });
    ol.createEl("li", { text: "Credentials → Create credentials → OAuth client ID → Application type “TVs and Limited Input devices”." });
    ol.createEl("li", { text: "Paste the client ID and secret below, then click “Sign in with Google”. Repeat the sign-in on each device." });

    new Setting(el)
      .setName("OAuth client ID")
      .addText((t) => t.setValue(g.clientId).onChange(async (v) => ((g.clientId = v.trim()), await save())));
    new Setting(el).setName("OAuth client secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(g.clientSecret).onChange(async (v) => ((g.clientSecret = v.trim()), await save()));
    });
    new Setting(el)
      .setName("Drive folder name")
      .setDesc("Folder in “My Drive” that stores the vault. Created automatically.")
      .addText((t) =>
        t.setValue(g.folderName).onChange(async (v) => {
          g.folderName = v.trim();
          g.folderId = "";
          await save();
        })
      );

    new Setting(el)
      .setName("Account")
      .setDesc(g.refreshToken ? "Signed in ✔" : "Not signed in")
      .addButton((b) =>
        b
          .setButtonText(g.refreshToken ? "Sign in again" : "Sign in with Google")
          .setCta()
          .onClick(async () => {
            if (!g.clientId || !g.clientSecret) {
              new Notice("Enter the OAuth client ID and secret first.");
              return;
            }
            try {
              const code = await startDeviceFlow(g.clientId);
              new DeviceCodeModal(this.app, "Sign in with Google", code.verification_url, code.user_code, async (cancelled) => {
                const t = await pollDeviceFlow(g, code, cancelled);
                g.refreshToken = t.refreshToken;
                g.accessToken = t.accessToken;
                g.accessTokenExpiry = Date.now() + t.expiresIn * 1000;
                await save();
                new Notice("Cloud Sync: signed in to Google Drive.");
                this.display();
              }).open();
            } catch (e) {
              new Notice(`Google sign-in failed: ${e instanceof Error ? e.message : e}`, 10000);
            }
          })
      )
      .addButton((b) =>
        b.setButtonText("Sign out").onClick(async () => {
          g.refreshToken = "";
          g.accessToken = "";
          g.accessTokenExpiry = 0;
          await save();
          this.display();
        })
      );
    this.addTestButton(el);
  }

  private displayMega(el: HTMLElement) {
    const m = this.plugin.settings.mega;
    const save = () => this.plugin.saveSettings();
    new Setting(el).setName("MEGA").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text:
        "Sign in with your MEGA account (free accounts get 20 GB). Your password is used once to create a " +
        "session and is not saved. Free accounts can download about 5 GB per day, which is plenty for notes, " +
        "but the first sync of a very large vault onto a new device may need more than one day.",
    });

    new Setting(el)
      .setName("MEGA folder name")
      .setDesc("Folder in your MEGA Cloud Drive that stores the vault. Created automatically.")
      .addText((t) => t.setValue(m.folderName).onChange(async (v) => ((m.folderName = v.trim()), await save())));

    if (m.session) {
      new Setting(el)
        .setName("Account")
        .setDesc(`Signed in as ${m.session.email} ✔`)
        .addButton((b) =>
          b.setButtonText("Sign out").onClick(async () => {
            m.session = null;
            await save();
            this.display();
          })
        );
    } else {
      let email = "";
      let password = "";
      let code = "";
      new Setting(el).setName("Email").addText((t) => t.onChange((v) => (email = v.trim())));
      new Setting(el).setName("Password").addText((t) => {
        t.inputEl.type = "password";
        t.onChange((v) => (password = v));
      });
      new Setting(el)
        .setName("Two-factor code")
        .setDesc("Only if you turned on two-factor authentication in MEGA.")
        .addText((t) => t.setPlaceholder("123456").onChange((v) => (code = v.trim())));
      new Setting(el).addButton((b) =>
        b
          .setButtonText("Sign in to MEGA")
          .setCta()
          .onClick(async () => {
            if (!email || !password) {
              new Notice("Enter your MEGA email and password.");
              return;
            }
            b.setDisabled(true).setButtonText("Signing in…");
            try {
              m.session = await megaLogin(email, password, code);
              await save();
              new Notice("Cloud Sync: signed in to MEGA.");
              this.display();
            } catch (e) {
              new Notice(e instanceof Error ? e.message : String(e), 10000);
              b.setDisabled(false).setButtonText("Sign in to MEGA");
            }
          })
      );
    }
    this.addTestButton(el);
  }

  private displayOneDrive(el: HTMLElement) {
    const o = this.plugin.settings.onedrive;
    const save = () => this.plugin.saveSettings();
    new Setting(el).setName("OneDrive").setHeading();
    const help = el.createEl("div", { cls: "setting-item-description" });
    help.createEl("p", {
      text:
        "Works with school/work Microsoft 365 accounts (usually 100 GB – 1 TB, set by your school) and personal " +
        "Microsoft accounts (5 GB free). One-time setup, about 5 minutes — you register your own app so no third party gets access:",
    });
    const ol = help.createEl("ol");
    ol.createEl("li", { text: "Go to entra.microsoft.com (or portal.azure.com) → App registrations → New registration. Name it “Obsidian Cloud Sync”." });
    ol.createEl("li", {
      text:
        "Supported account types: “Accounts in any organizational directory and personal Microsoft accounts”. " +
        "No redirect URI is needed. Click Register.",
    });
    ol.createEl("li", { text: "Authentication → Advanced settings → “Allow public client flows” → Yes → Save." });
    ol.createEl("li", { text: "API permissions → Add → Microsoft Graph → Delegated → Files.ReadWrite and offline_access." });
    ol.createEl("li", { text: "Copy the “Application (client) ID” from Overview into the box below, then click “Sign in with Microsoft”." });
    help.createEl("p", {
      text:
        "If your school doesn't let students register apps, register it with a personal Microsoft account instead. " +
        "If sign-in then says an admin must approve the app, your school's IT team has to allow it.",
    });

    new Setting(el)
      .setName("Application (client) ID")
      .addText((t) =>
        t
          .setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
          .setValue(o.clientId)
          .onChange(async (v) => ((o.clientId = v.trim()), await save()))
      );
    new Setting(el)
      .setName("Tenant")
      .setDesc(
        "Leave as “common”. Only if you registered the app as single-tenant inside your school's directory, " +
          "enter your school's domain (e.g. myuniversity.edu) here."
      )
      .addText((t) => t.setValue(o.tenant).onChange(async (v) => ((o.tenant = v.trim() || "common"), await save())));
    new Setting(el)
      .setName("OneDrive folder name")
      .setDesc("Folder in your OneDrive that stores the vault. Created automatically.")
      .addText((t) => t.setValue(o.folderName).onChange(async (v) => ((o.folderName = v.trim()), await save())));

    new Setting(el)
      .setName("Account")
      .setDesc(o.refreshToken ? "Signed in ✔" : "Not signed in")
      .addButton((b) =>
        b
          .setButtonText(o.refreshToken ? "Sign in again" : "Sign in with Microsoft")
          .setCta()
          .onClick(async () => {
            if (!o.clientId) {
              new Notice("Enter the application (client) ID first.");
              return;
            }
            try {
              const code = await msStartDeviceFlow(o.clientId, o.tenant);
              new DeviceCodeModal(this.app, "Sign in with Microsoft", code.verification_uri, code.user_code, async (cancelled) => {
                const t = await msPollDeviceFlow(o, code, cancelled);
                o.refreshToken = t.refreshToken;
                o.accessToken = t.accessToken;
                o.accessTokenExpiry = Date.now() + t.expiresIn * 1000;
                await save();
                new Notice("Cloud Sync: signed in to OneDrive.");
                this.display();
              }).open();
            } catch (e) {
              new Notice(e instanceof Error ? e.message : String(e), 10000);
            }
          })
      )
      .addButton((b) =>
        b.setButtonText("Sign out").onClick(async () => {
          o.refreshToken = "";
          o.accessToken = "";
          o.accessTokenExpiry = 0;
          await save();
          this.display();
        })
      );
    this.addTestButton(el);
  }

  private addTestButton(el: HTMLElement) {
    new Setting(el).setName("Test connection").addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        try {
          const p = this.plugin.createProvider();
          p.validate();
          const files = await p.list();
          await p.close?.();
          new Notice(`Connected to ${p.name}. ${files.size} file(s) stored remotely.`);
        } catch (e) {
          new Notice(`Connection failed: ${e instanceof Error ? e.message : e}`, 10000);
        }
      })
    );
  }
}

/** Shows a device-code sign-in (Google / Microsoft): open a link anywhere, type the code. */
class DeviceCodeModal extends Modal {
  private cancelled = false;

  constructor(
    app: App,
    private title: string,
    private url: string,
    private userCode: string,
    private run: (cancelled: () => boolean) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(this.title);
    contentEl.createEl("p", { text: "1. Open this link (on any device):" });
    const link = contentEl.createEl("a", { text: this.url, href: this.url });
    link.setAttr("target", "_blank");
    contentEl.createEl("p", { text: "2. Enter this code:" });
    const codeEl = contentEl.createEl("div", { text: this.userCode });
    codeEl.style.fontSize = "1.8em";
    codeEl.style.fontWeight = "bold";
    codeEl.style.letterSpacing = "0.1em";
    codeEl.style.userSelect = "text";
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Copy code").onClick(() => navigator.clipboard.writeText(this.userCode))
    );
    const status = contentEl.createEl("p", { text: "Waiting for approval…", cls: "setting-item-description" });

    this.run(() => this.cancelled)
      .then(() => this.close())
      .catch((e) => {
        if (!this.cancelled) status.setText(`Failed: ${e instanceof Error ? e.message : e}`);
      });
  }

  onClose() {
    this.cancelled = true;
    this.contentEl.empty();
  }
}

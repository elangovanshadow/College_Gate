# Cloud Sync (GitHub, Google Drive & MEGA) — Obsidian plugin

Sync your Obsidian vault across all your devices (Windows, macOS, Linux, Android, iOS) using
**a GitHub repository**, **Google Drive** or **MEGA** (20 GB free). No servers, no subscriptions — your notes go straight
from your device to your own account.

## Features

- **Three backends:** a (private) GitHub repo, a folder in your Google Drive, or a folder in your MEGA account (20 GB free, end-to-end encrypted).
- **Works on mobile:** it doesn't need Git or Node installed; it only makes HTTPS calls.
- **Real two-way sync:** it compares each file with the version from the last sync, so it knows which side changed.
  - Changed on one device only → the change is copied to the other side.
  - Deleted on one device → deleted everywhere. Local deletions go to the vault's `.trash`, and Drive deletions go to the Drive trash.
  - Edited on both devices → your local version is kept and the other version is saved next to it as `note (conflict remote 2026-…).md`. Nothing is lost.
  - Deleted on one device but edited on another → the edit wins.
- **GitHub history:** every sync is one commit, so you get full version history for free.
- **Auto-sync** on startup and every *N* minutes, plus a ribbon button, a status-bar button and the **Cloud Sync: Sync now** command.
- **Safety guard:** it asks before a sync that would delete many files, for example after you point it at the wrong repo.
- Optionally syncs your `.obsidian` settings, themes and plugins. It never syncs the workspace layout or this plugin's own `data.json`, which holds your tokens.
- Exclude patterns (`.trash/`, `**/.DS_Store`, `Private/`, `*.tmp`, …) and a max file size.

## Install

1. Build it (or use the prebuilt `main.js` in this folder):
   ```bash
   npm install
   npm run build
   ```
2. In your vault, create the folder `.obsidian/plugins/cloud-sync-gh-gdrive/`.
3. Copy `main.js` and `manifest.json` into it.
4. In Obsidian go to **Settings → Community plugins**, turn off Restricted mode, and enable **Cloud Sync (GitHub & Google Drive)**.
5. Do the same on every device, using the same sync settings.

> **Phones:** copy the `cloud-sync-gh-gdrive` folder into the vault's `.obsidian/plugins/` folder once, using USB,
> the Files app or any file manager. After that, the plugin can keep itself in sync if you turn on **Sync settings folder**.

## Setup: GitHub

1. Create a **private** repository, for example `my-vault`. It can be empty.
2. Go to GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.
   - Repository access: *Only select repositories* → `my-vault`
   - Permissions: **Contents → Read and write**
3. In the plugin settings choose **GitHub repository** and fill in the token, owner (your username), repo name and branch (`main`).
4. Click **Test**, then **Sync now**.

## Setup: Google Drive

The plugin uses your *own* Google OAuth client, so no third-party app ever gets access to your
Drive. It asks only for the `drive.file` scope, which lets it see files it created and nothing else.

1. Go to <https://console.cloud.google.com/> and create a project.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **OAuth consent screen** → User type *External* → fill in the app name and your email → add yourself under **Test users**.
   (Or click *Publish app*. Otherwise Google expires test-mode sign-ins after 7 days.)
4. **Credentials → Create credentials → OAuth client ID** → Application type **TVs and Limited Input devices**.
5. Copy the **Client ID** and **Client secret** into the plugin settings.
6. Click **Sign in with Google**. A code appears. Open the link on any device, enter the code and approve.
7. Click **Test**, then **Sync now**. Repeat step 6 on every device.

The vault is stored as files inside the Drive folder you name (default **Obsidian Cloud Sync**).
Each file is named after its path inside the vault, for example `Daily/2026-09-26.md`.

## Setup: MEGA (20 GB free)

1. Create a free account at <https://mega.nz> if you don't have one.
2. In the plugin settings choose **MEGA (20 GB free)**.
3. Enter your MEGA email and password, plus the 6-digit code if you use two-factor authentication. Click **Sign in to MEGA**.
   Your password is used once to create a login session and is **not saved**. Only the session is kept, in this device's plugin settings, and it is never synced.
4. Click **Test**, then **Sync now**. Repeat the sign-in on every device.

The vault is stored as a normal folder tree inside the MEGA folder you name (default **Obsidian Cloud Sync**), so you
can also browse your notes in the MEGA app. Files you delete go to the MEGA **Rubbish bin**, where you can recover them.

**MEGA limits:** free accounts can download about **5 GB per day**. That's plenty for day-to-day syncing of notes,
but the first sync of a very large vault (many GB of PDFs or videos) onto a new device may need more than one day.
The plugin tells you when the limit is hit. Just sync again later and it continues where it stopped.
Signing out of all sessions in MEGA's security settings logs the plugin out too. Sign in again in its settings.

## Notes and limits

- Don't sync the same vault with another sync tool (Obsidian Sync, iCloud, Dropbox) at the same time.
- GitHub rejects files over 100 MB, and repositories work best when they stay under about 1 GB. For vaults with lots of big PDFs or videos, use Google Drive.
- If two devices sync at the exact same moment, GitHub rejects the second one ("branch changed while syncing"). Just sync again.
- **Reset sync state** in settings makes the next sync merge-only, with no deletions. Use it if you ever get confused about what synced.

## Development

```bash
npm install
npm run dev     # rebuilds main.js on change
npm run build   # type-check + production build
```

Source: `src/main.ts` (plugin), `src/sync.ts` (sync engine), `src/providers/github.ts`,
`src/providers/gdrive.ts`, `src/providers/mega.ts`, `src/settings.ts`.

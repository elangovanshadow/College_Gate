export type ProviderType = "github" | "gdrive" | "mega";

export interface RemoteEntry {
  /** Vault-relative path. */
  path: string;
  /** Git-blob SHA-1 of the file content (same format for every provider). */
  hash: string;
  /** Provider-specific id (e.g. Google Drive file id). */
  id?: string;
}

export interface Upload {
  path: string;
  hash: string;
  data: ArrayBuffer;
}

export interface SyncProvider {
  readonly name: string;
  /** Throws a descriptive error when the provider is not configured. */
  validate(): void;
  /** Returns every file currently stored remotely, keyed by path. */
  list(): Promise<Map<string, RemoteEntry>>;
  download(entry: RemoteEntry): Promise<ArrayBuffer>;
  /** Applies uploads and deletions remotely (atomically if the backend supports it). */
  apply(uploads: Upload[], deletes: RemoteEntry[], message: string): Promise<void>;
  /** Optional cleanup once a sync finishes. */
  close?(): Promise<void>;
}

export interface GitHubSettings {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** Optional sub-folder inside the repository that holds the vault. */
  rootDir: string;
}

export interface GDriveSettings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiry: number;
  /** Name of the folder (in My Drive) that holds the vault. */
  folderName: string;
  folderId: string;
}

export interface MegaSettings {
  /** Login session (no password is stored). */
  session: { key: string; sid: string; name: string; user: string; email: string } | null;
  /** Name of the folder (in the MEGA Cloud Drive root) that holds the vault. */
  folderName: string;
}

export interface LocalCacheEntry {
  hash: string;
  mtime: number;
  size: number;
}

export interface SyncState {
  /** Identifies the remote target the base snapshot belongs to. */
  target: string;
  /** path -> hash of the file as it was after the last successful sync. */
  base: Record<string, string>;
  /** path -> cached local hash (skips re-hashing unchanged files). */
  localCache: Record<string, LocalCacheEntry>;
  lastSync: number;
}

export interface CloudSyncSettings {
  provider: ProviderType;
  github: GitHubSettings;
  gdrive: GDriveSettings;
  mega: MegaSettings;
  deviceName: string;
  syncOnStartup: boolean;
  autoSyncMinutes: number;
  syncConfigDir: boolean;
  excludePatterns: string;
  maxFileSizeMB: number;
  showNotices: boolean;
  state: SyncState;
}

export const DEFAULT_SETTINGS: CloudSyncSettings = {
  provider: "github",
  github: { token: "", owner: "", repo: "", branch: "main", rootDir: "" },
  gdrive: {
    clientId: "",
    clientSecret: "",
    refreshToken: "",
    accessToken: "",
    accessTokenExpiry: 0,
    folderName: "Obsidian Cloud Sync",
    folderId: "",
  },
  mega: { session: null, folderName: "Obsidian Cloud Sync" },
  deviceName: "",
  syncOnStartup: true,
  autoSyncMinutes: 10,
  syncConfigDir: false,
  excludePatterns: ".trash/\n.git/\n**/.DS_Store",
  maxFileSizeMB: 50,
  showNotices: true,
  state: { target: "", base: {}, localCache: {}, lastSync: 0 },
};

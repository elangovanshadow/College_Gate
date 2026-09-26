import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

const encoder = new TextEncoder();

/** Computes the git blob SHA-1 ("blob <len>\0<content>"), identical to GitHub's blob sha. */
export async function gitBlobSha(data: ArrayBuffer): Promise<string> {
  const header = encoder.encode(`blob ${data.byteLength}\0`);
  const buf = new Uint8Array(header.byteLength + data.byteLength);
  buf.set(header, 0);
  buf.set(new Uint8Array(data), header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

/** requestUrl wrapper that never throws on HTTP status, so we can build good error messages. */
export async function http(params: RequestUrlParam): Promise<RequestUrlResponse> {
  const res = await requestUrl({ ...params, throw: false });
  if (res.status >= 400) {
    let detail = "";
    try {
      const j = res.json;
      detail = j?.message || j?.error_description || j?.error?.message || JSON.stringify(j);
    } catch {
      detail = res.text?.slice(0, 300) ?? "";
    }
    throw new HttpError(res.status, `HTTP ${res.status} ${params.method ?? "GET"} ${params.url}: ${detail}`, res.text);
  }
  return res;
}

/** Runs async tasks with a concurrency limit. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Converts newline-separated glob patterns into matchers.
 * `*` matches within a path segment, `**` across segments. A pattern also matches
 * everything inside a folder of that name (so ".trash/" and ".trash" both exclude the folder).
 */
export function compileExcludes(patterns: string): ((path: string) => boolean)[] {
  return patterns
    .split("\n")
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
    .filter((p) => p && !p.startsWith("#"))
    .map((p) => {
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
        } else if (c === "*") re += "[^/]*";
        else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      }
      const full = new RegExp(`^${re}(?:/.*)?$`);
      return (path: string) => full.test(path);
    });
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

export function conflictPath(path: string, device: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const tag = `conflict ${device ? device + " " : ""}${stamp}`.replace(/[\\/:*?"<>|]/g, "-");
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot > slash + 1) return `${path.slice(0, dot)} (${tag})${path.slice(dot)}`;
  return `${path} (${tag})`;
}

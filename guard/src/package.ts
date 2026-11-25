// package.ts — The delivery as a package (SPEC §5, "what the gate proves ends at the delivery"): the gate builds
// it once, runs the checks and the task tests against it, and records its digest with the verdict. A folder on
// the live server is then compared with that record, file by file, so copying the wrong or an old folder is seen.
//
// A package is a file (an app.war, a zip) or a folder (a site). Its manifest names every file by its path
// inside the package (with "/", whatever the system) and the sha256 of its bytes; a file package has one entry,
// under the empty name, so a live copy may be named differently. The digest is the sha256 of the manifest.

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

export type Manifest = Record<string, string>;
export type PackageInfo = { digest: string; files: number; bytes: number; kind: "file" | "folder" };
export type Difference = { changed: string[]; missing: string[]; extra: string[] };

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** The manifest of the file or folder at PATH. In a folder, paths starting with one of IGNORE (relative, with
 * "/") are left out: what the live server writes there itself (logs, uploads). */
export function manifestOf(path: string, ignore: string[] = []): Manifest {
  const st = statSync(path);
  if (!st.isDirectory()) return { "": sha256(readFileSync(path)) };
  const out: Manifest = {};
  const skip = ignore.map(i => i.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip.some(s => r === s || r.startsWith(`${s}/`))) continue;
      const full = join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) walk(full, r);
      else if (s.isFile()) out[r] = sha256(readFileSync(full));
    }
  };
  walk(path, "");
  return out;
}

/** One digest for a whole manifest: the same files with the same bytes always give the same digest. */
export function digestOf(m: Manifest): string {
  return sha256(Object.keys(m).sort().map(k => `${k}\t${m[k]}\n`).join(""));
}

export function packageInfo(path: string, m: Manifest): PackageInfo {
  const kind = statSync(path).isDirectory() ? "folder" : "file";
  let bytes = 0;
  if (kind === "file") bytes = statSync(path).size;
  else for (const k of Object.keys(m)) bytes += statSync(join(path, ...k.split("/"))).size;
  return { digest: digestOf(m), files: Object.keys(m).length, bytes, kind };
}

/** What differs between the package as recorded (EXPECTED) and a copy of it (ACTUAL). */
export function compare(expected: Manifest, actual: Manifest): Difference {
  const changed: string[] = [], missing: string[] = [], extra: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in actual)) missing.push(k);
    else if (actual[k] !== v) changed.push(k);
  }
  for (const k of Object.keys(actual)) if (!(k in expected)) extra.push(k);
  return { changed, missing, extra };
}

export const same = (d: Difference) => !d.changed.length && !d.missing.length && !d.extra.length;

/** Copies the file or folder FROM to TO (TO is the file's new path, or the folder to fill). */
export function copyPackage(from: string, to: string) {
  if (!statSync(from).isDirectory()) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); return; }
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const f = join(from, name);
    const s = statSync(f);
    if (s.isDirectory()) copyPackage(f, join(to, name));
    else if (s.isFile()) copyFileSync(f, join(to, name));
  }
}

/** The difference in words, a few paths of each kind. */
export function differenceText(d: Difference): string {
  const few = (xs: string[]) => xs.slice(0, 8).map(x => x || "(the file)").join(", ") + (xs.length > 8 ? `, and ${xs.length - 8} more` : "");
  return [d.changed.length ? `  changed (${d.changed.length}): ${few(d.changed)}` : "",
          d.missing.length ? `  missing (${d.missing.length}): ${few(d.missing)}` : "",
          d.extra.length ? `  not in the package (${d.extra.length}): ${few(d.extra)}` : ""].filter(Boolean).join("\n");
}

export const isEmptyOrAbsent = (dir: string) => !existsSync(dir) || (statSync(dir).isDirectory() && readdirSync(dir).length === 0);

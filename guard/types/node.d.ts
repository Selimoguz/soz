// node.d.ts — The few Node APIs soz-guard uses, typed here instead of depending on @types/node.

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, options?: { mode?: number } | string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { size: number; mtimeMs: number };
  export function copyFileSync(from: string, to: string): void;
  export function appendFileSync(path: string, data: string, encoding: "utf8"): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function basename(path: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
  export function homedir(): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare module "node:child_process" {
  export function execFileSync(file: string, args: string[], options: {
    cwd?: string; encoding: "utf8"; maxBuffer?: number; input?: string; env?: Record<string, string | undefined>;
    stdio?: ("pipe" | "ignore")[];
  }): string;
  type SpawnResult = { status: number | null; stdout: string; stderr: string; signal?: string | null; error?: Error & { code?: string } };
  type SpawnOptions = {
    cwd?: string; encoding: "utf8"; input?: string; timeout?: number; maxBuffer?: number;
    env?: Record<string, string | undefined>; windowsHide?: boolean;
  };
  export function spawnSync(file: string, args: string[], options: SpawnOptions): SpawnResult;
  /** A whole command line, run through a shell (as Claude Code runs a hook command). */
  export function spawnSync(command: string, options: SpawnOptions & { shell: true }): SpawnResult;
}

declare module "node:crypto" {
  interface Hash { update(data: string, encoding?: "utf8"): Hash; digest(encoding: "hex"): string }
  export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:readline" {
  interface Interface { question(q: string, f: (answer: string) => void): void; close(): void }
  export function createInterface(o: { input: unknown; output: unknown }): Interface;
}

declare const process: {
  argv: string[]; env: Record<string, string | undefined>; execPath: string; platform: string; pid: number;
  cwd(): string; exit(code?: number): never;
  stdout: { write(s: string): void }; stderr: { write(s: string): void };
  stdin: { isTTY?: boolean };
};
declare const console: { log(...args: unknown[]): void };

interface ImportMeta { url: string }

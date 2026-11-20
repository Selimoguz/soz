// node.d.ts — The few Node APIs soz-guard uses, typed here instead of depending on @types/node.

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare module "node:child_process" {
  export function execFileSync(file: string, args: string[], options: {
    cwd?: string; encoding: "utf8"; maxBuffer?: number; input?: string; env?: Record<string, string | undefined>;
    stdio?: ("pipe" | "ignore")[];
  }): string;
  export function spawnSync(file: string, args: string[], options: { cwd?: string; encoding: "utf8"; input?: string }): {
    status: number | null; stdout: string; stderr: string;
  };
}

declare const process: {
  argv: string[]; env: Record<string, string | undefined>; execPath: string;
  cwd(): string; exit(code?: number): never;
  stdout: { write(s: string): void }; stderr: { write(s: string): void };
};
declare const console: { log(...args: unknown[]): void };

interface ImportMeta { url: string }

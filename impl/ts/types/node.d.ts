// node.d.ts — The few Node APIs soz uses, typed here instead of depending on @types/node.

declare module "node:crypto" {
  interface Hash { update(data: string, encoding?: "utf8"): Hash; digest(encoding: "hex"): string }
  export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function appendFileSync(path: string, data: string, encoding: "utf8"): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare const process: { argv: string[]; exit(code?: number): never };
declare const console: { log(...args: unknown[]): void; error(...args: unknown[]): void };

interface ImportMeta { url: string }

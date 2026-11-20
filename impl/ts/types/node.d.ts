// node.d.ts — The few Node APIs soz uses, typed here instead of depending on @types/node.

declare module "node:crypto" {
  interface Hash { update(data: string, encoding?: "utf8"): Hash; digest(encoding: "hex"): string }
  export function createHash(algorithm: "sha256"): Hash;
  export function randomInt(max: number): number;
  interface KeyObject {
    export(o: { format: "jwk" }): { x?: string; d?: string; crv?: string; kty?: string };
    export(o: { format: "pem"; type: "pkcs8"; cipher?: string; passphrase?: string }): string;
  }
  export function generateKeyPairSync(type: "ed25519"): { publicKey: KeyObject; privateKey: KeyObject };
  export function createPrivateKey(o: string | { key: string; passphrase?: string } | { key: object; format: "jwk" }): KeyObject;
  export function createPublicKey(o: { key: object; format: "jwk" }): KeyObject;
  export function sign(algorithm: null, data: Uint8Array, key: KeyObject): Uint8Array;
  export function verify(algorithm: null, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, options?: { flag?: "w" | "wx"; mode?: number }): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function unlinkSync(path: string): void;
  export function statSync(path: string): { mtimeMs: number };
  export function appendFileSync(path: string, data: string, encoding: "utf8"): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

interface Readable {
  on(event: "data", f: (chunk: unknown) => void): void; setEncoding?(e: "utf8"): void;
  isTTY?: boolean; setRawMode?(raw: boolean): void; pause?(): void; resume?(): void;
  removeListener?(event: "data", f: (chunk: unknown) => void): void;
}
declare const Buffer: {
  from(data: Uint8Array): { toString(encoding: "base64url"): string };
  from(data: string, encoding: "base64url"): Uint8Array;
};
interface Writable { write(s: string): boolean; end(): void }

declare module "node:child_process" {
  interface ChildProcess {
    stdin: Writable; stdout: Readable; stderr: Readable | null; pid?: number;
    on(event: "error", f: (e: Error & { code?: string }) => void): ChildProcess;
    on(event: "exit", f: (code: number | null) => void): ChildProcess;
    on(event: "close", f: (code: number | null) => void): ChildProcess;
    kill(): boolean;
  }
  export function spawn(command: string, args: string[], options?: {
    cwd?: string; env?: Record<string, string | undefined>; stdio?: ("pipe" | "ignore" | "inherit")[]; windowsHide?: boolean;
  }): ChildProcess;
}

declare module "node:readline" {
  interface Interface { on(event: "line", f: (line: string) => void): Interface; on(event: "close", f: () => void): Interface }
  export function createInterface(options: { input: Readable; crlfDelay?: number }): Interface;
}

declare const process: {
  argv: string[]; env: Record<string, string | undefined>; platform: string; execPath: string;
  stdin: Readable; stdout: Writable; stderr: Writable;
  cwd(): string; exit(code?: number): never;
};
declare const console: { log(...args: unknown[]): void; error(...args: unknown[]): void };
declare class TextEncoder { encode(s: string): Uint8Array }
declare function setTimeout(f: () => void, ms: number): unknown;
declare function clearTimeout(t: unknown): void;

interface ImportMeta { url: string }

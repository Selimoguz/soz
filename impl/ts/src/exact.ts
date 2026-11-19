// exact.ts — Exact numbers, an exact JSON reader, canonical JSON (SPEC 10.6) and folding (SPEC 3).
// No floating point anywhere: 0.1 is 1/10, and 0.1 + 0.2 is exactly 3/10.

import { createHash } from "node:crypto";

function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export class Rational {
  readonly n: bigint;
  readonly d: bigint;

  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error("division by zero");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }

  static of(x: number | bigint): Rational { return new Rational(BigInt(x)); }

  /** "-?digits(.digits)?([eE][+-]?digits)?" exactly, or null. */
  static parse(s: string): Rational | null {
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!m) return null;
    const frac = m[3] ?? "";
    let n = BigInt(m[2] + frac);
    let d = 10n ** BigInt(frac.length);
    const e = m[4] ? Number(m[4]) : 0;
    if (e > 0) n *= 10n ** BigInt(e);
    if (e < 0) d *= 10n ** BigInt(-e);
    return new Rational(m[1] ? -n : n, d);
  }

  add(o: Rational): Rational { return new Rational(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Rational): Rational { return new Rational(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Rational): Rational { return new Rational(this.n * o.n, this.d * o.d); }
  div(o: Rational): Rational { return new Rational(this.n * o.d, this.d * o.n); }
  neg(): Rational { return new Rational(-this.n, this.d); }
  cmp(o: Rational): number { const x = this.n * o.d - o.n * this.d; return x < 0n ? -1 : x > 0n ? 1 : 0; }
  eq(o: Rational): boolean { return this.n === o.n && this.d === o.d; }
  isZero(): boolean { return this.n === 0n; }
  isNegative(): boolean { return this.n < 0n; }

  /** Exact decimal without exponent or trailing zeros, or null if there is none (1/3). */
  decimal(): string | null {
    let d = this.d, twos = 0, fives = 0;
    while (d % 2n === 0n) { d /= 2n; twos++; }
    while (d % 5n === 0n) { d /= 5n; fives++; }
    if (d !== 1n) return null;
    const k = Math.max(twos, fives);
    if (k === 0) return this.n.toString();
    const scaled = (this.n < 0n ? -this.n : this.n) * 10n ** BigInt(k) / this.d;
    const s = scaled.toString().padStart(k + 1, "0");
    const int = s.slice(0, s.length - k);
    const frac = s.slice(s.length - k).replace(/0+$/, "");
    return (this.n < 0n ? "-" : "") + int + (frac ? "." + frac : "");
  }

  toString(): string { return this.decimal() ?? `${this.n}/${this.d}`; }
}

// --- JSON with exact numbers -------------------------------------------------------------------

export type Json = null | boolean | string | Rational | Json[] | { [key: string]: Json };

/** What an implementation may return: JSON, with numbers also as bigint or JS numbers (made exact). */
export type HostValue = null | boolean | string | number | bigint | Rational | HostValue[] | { [key: string]: HostValue };

export function isObject(x: unknown): x is { [key: string]: Json } {
  return typeof x === "object" && x !== null && !Array.isArray(x) && !(x instanceof Rational);
}

export function newObject(): { [key: string]: Json } { return Object.create(null); }

/** JSON.parse, but numbers are Rationals read from their text (12.5 is 25/2, never a float). */
export function parseJson(text: string): Json {
  let i = 0;
  const fail = (m: string): never => { throw new Error(`JSON: ${m} at ${i}`); };
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const value = (): Json => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o = newObject(); ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("key expected");
        const k = str(); ws(); if (text[i] !== ":") fail("':' expected"); i++;
        o[k] = value(); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return o; }
        fail("',' or '}' expected");
      }
    }
    if (c === "[") {
      i++; const a: Json[] = []; ws();
      if (text[i] === "]") { i++; return a; }
      for (;;) {
        a.push(value()); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return a; }
        fail("',' or ']' expected");
      }
    }
    if (c === '"') return str();
    for (const [w, v] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(w, i)) { i += w.length; return v; }
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail("value expected");
    i += m![0].length;
    return Rational.parse(m![0])!;
  };
  const str = (): string => {
    i++; let out = "";
    for (;;) {
      if (i >= text.length) fail("unclosed string");
      const c = text[i++];
      if (c === '"') return out;
      if (c !== "\\") { out += c; continue; }
      const e = text[i++];
      if (e === "u") { out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4; }
      else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
    }
  };
  const v = value(); ws();
  if (i < text.length) fail("trailing characters");
  return v;
}

// --- Canonical JSON (SPEC 10.6) ------------------------------------------------------------------

export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export function jsonString(s: string): string {
  let out = '"';
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (code < 32) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += c;
  }
  return out + '"';
}

/** Something that writes itself as canonical JSON (run-time values do). */
export interface Canonical { canonical(): string }

export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return jsonString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Rational) { const d = v.decimal(); return d ?? jsonString(`${v.n}/${v.d}`); }
  if (typeof v === "number" || typeof v === "bigint") return canonicalJson(Rational.of(v));
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object" && typeof (v as Canonical).canonical === "function") return (v as Canonical).canonical();
  if (typeof v === "object") return canonicalObject(Object.entries(v as object));
  throw new Error(`cannot write ${String(v)} as JSON`);
}

export function canonicalObject(pairs: [string, unknown][]): string {
  const sorted = [...pairs].sort((a, b) => compareCodePoints(a[0], b[0]));
  return "{" + sorted.map(([k, x]) => jsonString(k) + ":" + canonicalJson(x)).join(",") + "}";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// --- Folding (SPEC 3) ------------------------------------------------------------------------------

export function fold(s: string): string {
  let out = "";
  for (const c of s.normalize("NFD")) {
    const code = c.codePointAt(0)!;
    if (code >= 0x300 && code <= 0x36f) continue;
    const l = c.toLowerCase();
    out += l === "ı" ? "i" : l;
  }
  return out;
}

export function nameFold(s: string): string { return fold(s).replaceAll("_", "-"); }

/** Unicode letters and decimal digits (Common Lisp's alphanumericp on SBCL). */
export function isAlphanumeric(c: string): boolean { return /^[\p{L}\p{Nd}]$/u.test(c); }

// profile.ts — Language profiles (SPEC 5.4): number words in the message. With the Turkish profile,
// "yirmi koli" puts 20 among the message numbers, "iki yüz elli" 250, "2 bin" 2000. A profile is data
// (profiles/*.json), so another language needs no code. It only widens what counts as in the message;
// without one, nothing changes.

import { Rational, isObject, type Json } from "./exact.ts";

export type Profile = {
  language: string;
  units: Map<string, bigint>; hundred: Set<string>; scales: Map<string, bigint>; joiners: Set<string>; compound: boolean;
};

/** NFC, each code point lowercased, U+0307 removed (so İ is i). Letters keep their marks: ö is not o. */
export function profileLower(s: string): string {
  return Array.from(s.normalize("NFC")).map(c => c.toLowerCase()).join("").replace(/̇/g, "");
}

export function profileFromJson(j: Json): Profile {
  const n = isObject(j) && isObject(j.numbers) ? j.numbers : null;
  if (!isObject(j) || typeof j.language !== "string" || !n || !isObject(n.units))
    throw new Error('a profile is {"language": ..., "numbers": {"units": {...}, ...}}');
  const word = (w: string) => {
    if (!w || w !== profileLower(w) || !/^\p{L}+$/u.test(w)) throw new Error(`profile ${j.language}: ${JSON.stringify(w)} is not a lowercase word`);
    return w;
  };
  const int = (w: string, v: Json) => {
    if (!(v instanceof Rational) || v.d !== 1n || v.isNegative()) throw new Error(`profile ${j.language}: ${w} is not a whole number`);
    return v.n;
  };
  const strings = (x: Json | undefined) => (Array.isArray(x) ? x : []).map(w => word(String(w)));
  return {
    language: j.language,
    units: new Map(Object.entries(n.units).map(([w, v]) => [word(w), int(w, v)])),
    hundred: new Set(strings(n.hundred)),
    scales: new Map(Object.entries(isObject(n.scales) ? n.scales : {}).map(([w, v]) => [word(w), int(w, v)])),
    joiners: new Set(strings(n.joiners)),
    compound: n.compound === true,
  };
}

type Item = { kind: "unit"; v: bigint } | { kind: "hundred" } | { kind: "scale"; v: bigint };
type Token = { word: string | null; digits: string | null; joined: boolean };   // joined: only spaces or hyphens since the previous token

function item(p: Profile, w: string): Item | null {
  if (p.units.has(w)) return { kind: "unit", v: p.units.get(w)! };
  if (p.hundred.has(w)) return { kind: "hundred" };
  if (p.scales.has(w)) return { kind: "scale", v: p.scales.get(w)! };
  return null;
}

/** A word as number words: itself, or (compound profiles) split into them, longest first. */
function items(p: Profile, w: string): Item[] | null {
  const one = item(p, w);
  if (one) return [one];
  if (!p.compound) return null;
  const vocab = [...p.units.keys(), ...p.hundred, ...p.scales.keys()].sort((a, b) => b.length - a.length);
  const split = (rest: string): Item[] | null => {
    if (!rest) return [];
    for (const v of vocab) if (rest.startsWith(v)) { const tail = split(rest.slice(v.length)); if (tail) return [item(p, v)!, ...tail]; }
    return null;
  };
  return split(w);
}

/** The numbers the profile reads in MESSAGE (besides its digits, SPEC 5.1). */
export function profileNumbers(message: string, p: Profile, digitReadings: (run: string) => Rational[]): Rational[] {
  const text = profileLower(message), cs = Array.from(text);
  const tokens: Token[] = [];
  let gapOk = true, i = 0;
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  while (i < cs.length) {
    const c = cs[i];
    if (/\p{L}/u.test(c)) {
      let w = "";
      while (i < cs.length && /\p{L}/u.test(cs[i])) w += cs[i++];
      tokens.push({ word: w, digits: null, joined: gapOk }); gapOk = true;
    } else if (isDigit(c)) {
      let d = "";
      while (i < cs.length && (isDigit(cs[i]) || (".,".includes(cs[i]) && isDigit(cs[i + 1])))) d += cs[i++];
      tokens.push({ word: null, digits: d, joined: gapOk }); gapOk = true;
    } else {
      if (!/[\p{White_Space}-]/u.test(c)) gapOk = false;   // only white space and hyphens join number words
      i++;
    }
  }
  const out: Rational[] = [];
  const add = (v: Rational) => { if (!out.some(x => x.eq(v))) out.push(v); };
  let started = false, total = 0n, group = 0n, lastScale = -1n, prev = "";
  const emit = () => { if (started) add(Rational.of(total + group)); started = false; total = 0n; group = 0n; lastScale = -1n; prev = ""; };
  const take = (it: Item) => {
    if (it.kind === "unit") {
      const v = it.v, kind = v === 0n ? "zero" : v >= 10n && v <= 90n && v % 10n === 0n ? "tens" : "small";
      const extends_ = !started || prev === "hundred" || prev === "scale" || (prev === "tens" && kind === "small" && v < 10n);
      if (!extends_) emit();
      group += v; prev = kind; started = true;
    } else if (it.kind === "hundred") {
      const extends_ = !started || (prev === "small" && group > 0n && group < 100n) || prev === "scale";
      if (!extends_) emit();
      group = (group === 0n ? 1n : group) * 100n; prev = "hundred"; started = true;
    } else {
      const extends_ = !started || (group > 0n && (lastScale < 0n || it.v < lastScale));
      if (!extends_) emit();
      total += (group === 0n ? 1n : group) * it.v; group = 0n; lastScale = it.v; prev = "scale"; started = true;
    }
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (!t.joined) emit();
    if (t.digits !== null) {
      emit();
      // "2 bin", "2,5 milyon": the digits' readings times the scale that follows
      const next = tokens[k + 1], s = next?.word && next.joined ? p.scales.get(next.word) : undefined;
      if (s !== undefined) { for (const r of digitReadings(t.digits)) add(r.mul(Rational.of(s))); k++; }
      continue;
    }
    const w = t.word!;
    if (p.joiners.has(w)) {
      const next = tokens[k + 1];
      if (!(started && next?.word && next.joined && items(p, next.word))) emit();
      continue;
    }
    const its = items(p, w);
    if (!its) { emit(); continue; }
    for (const it of its) take(it);
  }
  emit();
  return out;
}

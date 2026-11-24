// rules.ts — What counts as work left unfinished without saying so.
//
// Each rule looks at one added line at a time. A rule may apply only to some file types and may
// skip some paths. A line that carries "soz-guard: ignore <reason>" is never reported: unfinished work is
// allowed, unsaid unfinished work is not.

export type Rule = {
  id: string;
  /** A regular expression, tested against one line. */
  pattern: string;
  flags?: string;
  message: string;
  /** File extensions (".ts") this rule applies to; all files if absent. */
  extensions?: string[];
  /** Glob patterns of paths this rule skips (in addition to the global exclude). */
  exclude?: string[];
};

const CODE = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".java", ".kt", ".cs", ".go",
              ".php", ".dart", ".swift", ".rs", ".py", ".rb", ".lisp", ".lsp", ".sql", ".scala", ".c", ".cpp", ".h"];
const C_LIKE = CODE.filter(e => ![".py", ".rb", ".lisp", ".lsp", ".sql"].includes(e));
const TESTS = ["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/fixtures/**", "**/mocks/**"];

/** Word boundaries that know Unicode letters: JavaScript's \b sees none around "ş". */
const W0 = String.raw`(?<![\p{L}\p{N}_])`, W1 = String.raw`(?![\p{L}\p{N}_])`;

/** A comment opener in most languages, then anything, then the words. Use with the "u" flag. */
const COMMENT = String.raw`(\/\/|#|\/\*|^\s*\*|<!--|--|;;)`;
const comment = (words: string) => String.raw`${COMMENT}.*${W0}(${words})${W1}`;

// The rule definitions below name what they look for, so each of those lines is marked for soz-guard itself.
export const defaultRules: Rule[] = [
  {
    id: "todo",
    pattern: comment(String.raw`TODO|FIXME|@todo`),   // soz-guard: ignore (the rule)
    flags: "u",
    message: "a TODO/FIXME comment",   // soz-guard: ignore (the rule)
  },
  {
    id: "not-implemented",   // soz-guard: ignore (the rule)
    pattern: String.raw`not[ _-]?implemented|NotImplemented(Error|Exception)|unimplemented!\(|todo!\(|throw new Error\(\s*["'\x60]\s*(TODO|TBD)`,   // soz-guard: ignore (the rule)
    flags: "i",
    message: "code that says it is not implemented",   // soz-guard: ignore (the rule)
    extensions: CODE,
  },
  {
    id: "swallowed-error",
    pattern: String.raw`\bcatch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*(\([^)]*\)|\w+)?\s*=>\s*\{\s*\}\s*\)|except[^:\n]*:\s*pass\b|\bhandler-case\b.*\(error\s*\(\)\s*nil\)`,
    message: "an error caught and silently dropped",
    extensions: CODE,
  },
  {
    id: "skipped-test",
    pattern: String.raw`\b(it|test|describe)\.(skip|todo)\(|\bx(it|describe|test)\(|@Disabled\b|@Ignore\b|pytest\.mark\.skip|\[Fact\(Skip\s*=`,   // soz-guard: ignore (the rule)
    message: "a test switched off",
    extensions: CODE,
  },
  {
    id: "deferred",
    // Phrases that put work off, not words that merely describe time ("retried later" is fine).
    pattern: comment(String.raw`for now|not yet implemented|hard-?coded|temporary (fix|hack|workaround|solution)`
      + String.raw`|(implement|add|handle|wire|connect|hook up|fill in|finish|complete|fix|replace|clean up|refactor)${W1}.{0,40}${W0}(later|eventually)`
      + String.raw`|şimdilik|geçici (çözüm|olarak|kod)|yapılacak|eklenecek|bağlanacak|doldurulacak|düzeltilecek|bakılacak`),   // soz-guard: ignore (the rule)
    flags: "iu",
    message: "a comment that puts work off",
    extensions: CODE,
  },
  {
    id: "elided",
    // "// ..." alone, or "... rest of the code" in a comment. Spread syntax is not a comment.  soz-guard: ignore (the rule)
    pattern: String.raw`${COMMENT}\s*\.{3}\s*(\*\/)?\s*$|${COMMENT}.*\.{3}\s*(rest|remaining|existing|other|same as|kalan|diğer|aynı)${W1}`,   // soz-guard: ignore (the rule)
    flags: "iu",
    message: "code left out and replaced by '...'",
    extensions: CODE,
  },
  {
    id: "fake-data",
    pattern: String.raw`lorem ipsum|\bexample\.(com|org|net)\b|\b(test@test|foo@bar|john\.doe@|user@example)|\bJohn Doe\b|\b(123456789|1234567890)\b`,   // soz-guard: ignore (the rule)
    flags: "i",
    message: "made-up data in the code",
    extensions: CODE,
    exclude: TESTS,
  },
  {
    id: "empty-function",
    // An empty function or method, or a UI handler that does nothing (an empty arrow passed to
    // on.../handle...), or a named arrow function that is a whole statement (`const cancel = () => {}`,
    // a class field `cancel = () => {}`). A plain no-op arrow elsewhere, such as an effect callback or a
    // default parameter, is not reported, nor is one named noop.
    pattern: String.raw`\bfunction\b[^{;]*\)\s*(:\s*[\w<>\[\]|. ]+)?\s*\{\s*\}`
      + String.raw`|^\s*(public |private |protected |static |async |override )*(?!(if|for|while|switch|catch|constructor|function)\b)\w+\s*\([^)]*\)\s*(:\s*[^{]+)?\{\s*\}\s*$`
      + String.raw`|\b(on[A-Z]\w*|handle[A-Z]\w*)\s*[=:]\s*\{?\s*(async\s*)?(\([^)]*\)|\w+)\s*=>\s*\{\s*\}`
      + String.raw`|^\s*(export\s+)?((const|let|var)\s+|(public |private |protected |static |readonly |override )*)(?!noop\b|_\w*\b)\w+\s*(:[^=]+)?=\s*(async\s*)?(\([^)]*\)|\w+)\s*(:\s*[^=]+)?=>\s*\{\s*\}\s*;?\s*$`,
    message: "a function or UI handler with an empty body",
    extensions: C_LIKE,
    exclude: TESTS,
  },
];

export const defaultExclude = [
  // prose and data, not code: a "TODO" in notes or a text corpus is not unfinished work  soz-guard: ignore (describes the rule)
  "**/*.md", "**/*.txt", "**/*.log", "**/*.csv",
  "**/*.lock", "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml",
  "**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/*.min.js", "**/*.map",
  // what builds and test runs leave behind: not the project's code, and not a change in a CI checkout
  "**/coverage/**", "**/.nyc_output/**", "**/__pycache__/**", "**/*.pyc", "**/.pytest_cache/**",
];

export const IGNORE_MARK = /soz-guard:\s*ignore\b/i;

/** The reason given after a "soz-guard: ignore" mark on LINE: null if there is no mark, "" if there is no
 * reason. A mark keeps a line from being reported only with a reason (what is left, and why); without one
 * it excuses nothing, since "unfinished, never silently" is the whole point of it. */
export function ignoreReason(line: string): string | null {
  const m = IGNORE_MARK.exec(line);
  if (!m) return null;
  // the mark quoted or named in prose ("...ignore" needs a reason, ...ignore <why>) is a mention, not a mark
  if (/^\s*["'`<)\]]/.test(line.slice(m.index + m[0].length))) return null;
  const reason = line.slice(m.index + m[0].length)
    .replace(/\s*(?:\*\/|-->|#\}|%>|\}\}).*$/, "")          // the end of the comment it is in
    .trim().replace(/^[:\-–—,;(\[]+\s*/, "").replace(/[)\]]+\s*$/, "").trim();
  return /\p{L}{3}/u.test(reason) ? reason.slice(0, 200) : "";
}

/** "**" any path, "*" anything but "/", "?" one character. Paths use "/". */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export const matchesAny = (path: string, globs: string[]) => globs.some(g => globToRegExp(g).test(path));

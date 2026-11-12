/**
 * Glob to regular expression, case-insensitive: `**` matches anything, `*` anything except `/`,
 * `?` one character except `/`.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

/** The first protected pattern matching the branch, if any. */
export function protectedBy(branch: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => pattern.trim() !== "" && globToRegExp(pattern.trim()).test(branch));
}

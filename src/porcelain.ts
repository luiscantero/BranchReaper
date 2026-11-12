/** One entry of `git worktree list --porcelain [-z]`. Paths are as printed by git. */
export interface Worktree {
  path: string;
  head?: string;
  /** Full ref, for example `refs/heads/feature/x`. Undefined when detached or bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  prunableReason?: string;
  /** The first entry is the main worktree (or the bare repository). */
  main: boolean;
}

/**
 * Parses `git worktree list --porcelain`. With `-z` (the default here) every attribute is
 * NUL-terminated and records end with an empty attribute; without it, lines and blank lines are
 * used instead. A `worktree` attribute always starts a new record.
 */
export function parseWorktreeList(output: string, nulTerminated = true): Worktree[] {
  const separator = nulTerminated ? "\0" : "\n";
  const tokens = output.split(separator);
  const result: Worktree[] = [];
  let current: Worktree | undefined;
  const finish = () => {
    if (current) {
      result.push(current);
      current = undefined;
    }
  };
  for (const raw of tokens) {
    const token = nulTerminated ? raw : raw.replace(/\r$/, "");
    if (token === "") {
      finish();
      continue;
    }
    const space = token.indexOf(" ");
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? undefined : token.slice(space + 1);
    if (key === "worktree") {
      finish();
      current = {
        path: nulTerminated ? value ?? "" : unquote(value ?? ""),
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        main: result.length === 0,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value;
        break;
      case "bare":
        current.bare = true;
        break;
      case "detached":
        current.detached = true;
        break;
      case "locked":
        current.locked = true;
        current.lockReason = value || undefined;
        break;
      case "prunable":
        current.prunable = true;
        current.prunableReason = value || undefined;
        break;
    }
  }
  finish();
  return result;
}

/** Undoes git's C-style quoting of paths with special characters (only used without `-z`). */
function unquote(value: string): string {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) {
    return value;
  }
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next) && /^[0-7]{3}$/.test(body.slice(i, i + 3))) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else if (next in escapes) {
      bytes.push(escapes[next]);
    } else {
      bytes.push(...Buffer.from("\\" + next, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Short branch name of a `refs/heads/...` ref, undefined for other refs. */
export function branchName(ref: string | undefined): string | undefined {
  return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
}

/** Fields requested from `git for-each-ref refs/heads`, separated by NUL, one branch per line. */
export const BRANCH_FORMAT = [
  "%(refname)",
  "%(objectname)",
  "%(upstream)",
  "%(upstream:track)",
  "%(upstream:remotename)",
  "%(upstream:remoteref)",
  "%(committerdate:unix)",
  "%(subject)",
].join("%00");

export interface BranchRef {
  /** Short name, for example `feature/x`. */
  name: string;
  sha: string;
  /** Remote-tracking ref of the upstream, for example `refs/remotes/origin/feature/x`. */
  upstream?: string;
  /** The upstream is configured but its remote-tracking ref no longer exists (`[gone]`). */
  upstreamGone: boolean;
  /** Remote of the upstream, for example `origin`. */
  remote?: string;
  /** Branch on the remote, for example `refs/heads/feature/x`. */
  remoteRef?: string;
  committerDate: number;
  subject: string;
}

export function parseBranches(output: string): BranchRef[] {
  const result: BranchRef[] = [];
  for (const line of output.split("\n")) {
    const fields = line.replace(/\r$/, "").split("\0");
    if (fields.length < 8 || !fields[0].startsWith("refs/heads/")) {
      continue;
    }
    const [ref, sha, upstream, track, remote, remoteRef, date] = fields;
    result.push({
      name: ref.slice("refs/heads/".length),
      sha,
      upstream: upstream || undefined,
      upstreamGone: track.trim() === "[gone]",
      remote: remote || undefined,
      remoteRef: remoteRef || undefined,
      committerDate: Number(date) || 0,
      subject: fields.slice(7).join("\0"),
    });
  }
  return result;
}

/** Branch names from `git branch --merged <base> --format=%(refname)`. */
export function parseMergedBranches(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const ref = line.trim();
    if (ref.startsWith("refs/heads/")) {
      names.add(ref.slice("refs/heads/".length));
    }
  }
  return names;
}

/**
 * - `merged`: reachable from the default branch (`git branch --merged`).
 * - `gone`: the upstream branch was deleted on the remote, typically after a (squash) merge.
 * - `squashMerged`: not an ancestor, but its changes are already in the default branch.
 * - `unmerged`: anything else.
 */
export type MergeStatus = "merged" | "gone" | "squashMerged" | "unmerged";

export function mergeStatus(
  branch: Pick<BranchRef, "name" | "upstreamGone">,
  merged: ReadonlySet<string>,
  contentMerged: ReadonlySet<string>,
): MergeStatus {
  if (merged.has(branch.name)) {
    return "merged";
  }
  if (branch.upstreamGone) {
    return "gone";
  }
  if (contentMerged.has(branch.name)) {
    return "squashMerged";
  }
  return "unmerged";
}

export function isMergedStatus(status: MergeStatus): boolean {
  return status !== "unmerged";
}

export function describeStatus(status: MergeStatus): string {
  switch (status) {
    case "merged":
      return "merged";
    case "gone":
      return "upstream gone";
    case "squashMerged":
      return "merged (squash)";
    case "unmerged":
      return "unmerged";
  }
}

/** Short relative age, for example `5m ago`, `2d ago` or `just now`. */
export function relativeAge(unixSeconds: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  const units: [number, string][] = [
    [365 * 86400, "y"],
    [7 * 86400, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  for (const [size, unit] of units) {
    if (seconds >= size) {
      return `${Math.floor(seconds / size)}${unit} ago`;
    }
  }
  return "just now";
}

/**
 * `git merge-tree --write-tree <base> <branch>`: a clean merge that produces the base's own tree
 * (this also covers an empty tree diff).
 */
export function isContentMerged(mergeTreeExitCode: number, mergeTreeStdout: string, baseTree: string): boolean {
  if (mergeTreeExitCode !== 0) {
    return false;
  }
  const tree = mergeTreeStdout.split(/\r?\n/, 1)[0].trim();
  return tree !== "" && tree === baseTree.trim();
}

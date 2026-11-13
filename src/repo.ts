import * as fs from "fs";
import * as path from "path";
import { BRANCH_FORMAT, BranchRef, MergeStatus, isContentMerged, mergeStatus, parseBranches, parseMergedBranches } from "./branches";
import { Git } from "./git";
import { nativePath, pathKey } from "./paths";
import { Worktree, parseWorktreeList } from "./porcelain";

export interface RepoInfo {
  /** Normalized `--git-common-dir`; identifies the repository across its worktrees. */
  key: string;
  commonDir: string;
  /** Main worktree, or the repository directory if it is bare. */
  mainPath: string;
  bare: boolean;
  name: string;
}

export interface BaseBranch {
  /** Ref to compare against, for example `refs/remotes/origin/main`. */
  ref: string;
  /** Short name, for example `main`. */
  name: string;
  remote?: string;
}

export interface RepoSnapshot {
  repo: RepoInfo;
  worktrees: Worktree[];
  branches: BranchRef[];
  statuses: Map<string, MergeStatus>;
  base?: BaseBranch;
  remotes: string[];
  defaultRemote?: string;
  /** Remote-tracking branches, for example `origin/feature/x`. */
  remoteBranches: Set<string>;
}

/** Resolves the repository containing `dir`, also when `dir` is inside a linked worktree. */
export async function resolveRepo(git: Git, dir: string): Promise<RepoInfo | undefined> {
  const result = await git.run(dir, ["rev-parse", "--git-common-dir"], { quiet: true });
  if (result.code !== 0) {
    return undefined;
  }
  const commonDir = path.resolve(dir, result.stdout.trim());
  const worktrees = await listWorktrees(git, dir);
  const main = worktrees[0];
  const bare = !main || main.bare;
  const mainPath = main && !main.bare && fs.existsSync(nativePath(main.path)) ? nativePath(main.path) : commonDir;
  const name = path.basename(bare ? commonDir.replace(/[\\/]\.git$/i, "") : mainPath).replace(/\.git$/i, "");
  return { key: pathKey(commonDir), commonDir, mainPath, bare, name };
}

let zSupported: boolean | undefined;

export async function listWorktrees(git: Git, cwd: string): Promise<Worktree[]> {
  if (zSupported !== false) {
    const result = await git.run(cwd, ["worktree", "list", "--porcelain", "-z"], { quiet: true });
    if (result.code === 0) {
      zSupported = true;
      return parseWorktreeList(result.stdout, true);
    }
    if (zSupported === undefined && /usage|unknown switch/i.test(result.stderr)) {
      zSupported = false;
    } else {
      throw new Error(`git worktree list failed: ${result.stderr.trim()}`);
    }
  }
  // Git before 2.36 has no -z.
  return parseWorktreeList(await git.exec(cwd, ["worktree", "list", "--porcelain"], { quiet: true }), false);
}

export async function findBase(git: Git, cwd: string, remotes: readonly string[]): Promise<{ base?: BaseBranch; defaultRemote?: string }> {
  const defaultRemote = remotes.includes("origin") ? "origin" : remotes[0];
  if (defaultRemote) {
    const head = await git.run(cwd, ["symbolic-ref", "--quiet", `refs/remotes/${defaultRemote}/HEAD`], { quiet: true });
    const ref = head.stdout.trim();
    const prefix = `refs/remotes/${defaultRemote}/`;
    if (head.code === 0 && ref.startsWith(prefix)) {
      return { base: { ref, name: ref.slice(prefix.length), remote: defaultRemote }, defaultRemote };
    }
    for (const name of ["main", "master"]) {
      if (await refExists(git, cwd, `${prefix}${name}`)) {
        return { base: { ref: `${prefix}${name}`, name, remote: defaultRemote }, defaultRemote };
      }
    }
  }
  for (const name of ["main", "master"]) {
    if (await refExists(git, cwd, `refs/heads/${name}`)) {
      return { base: { ref: `refs/heads/${name}`, name }, defaultRemote };
    }
  }
  return { defaultRemote };
}

async function refExists(git: Git, cwd: string, ref: string): Promise<boolean> {
  return (await git.run(cwd, ["show-ref", "--verify", "--quiet", ref], { quiet: true })).code === 0;
}

/** Cache of squash-merge checks, keyed by base and branch commit. */
const contentMergedCache = new Map<string, boolean>();

async function contentMergedBranches(
  git: Git,
  cwd: string,
  base: BaseBranch,
  candidates: readonly BranchRef[],
): Promise<Set<string>> {
  const result = new Set<string>();
  if (candidates.length === 0) {
    return result;
  }
  const baseSha = (await git.exec(cwd, ["rev-parse", base.ref], { quiet: true })).trim();
  const baseTree = (await git.exec(cwd, ["rev-parse", `${base.ref}^{tree}`], { quiet: true })).trim();
  let mergeTreeSupported = true;
  const check = async (branch: BranchRef) => {
    const key = `${baseSha}:${branch.sha}`;
    let merged = contentMergedCache.get(key);
    if (merged === undefined) {
      merged = false;
      if (mergeTreeSupported) {
        const r = await git.run(cwd, ["merge-tree", "--write-tree", "--no-messages", base.ref, branch.sha], { quiet: true });
        if (r.code === 0 || r.code === 1) {
          merged = isContentMerged(r.code, r.stdout, baseTree);
        } else {
          // Git before 2.38: fall back to an empty tree diff.
          mergeTreeSupported = false;
        }
      }
      if (!mergeTreeSupported) {
        merged = (await git.run(cwd, ["diff", "--quiet", base.ref, branch.sha], { quiet: true })).code === 0;
      }
      contentMergedCache.set(key, merged);
    }
    if (merged) {
      result.add(branch.name);
    }
  };
  const queue = [...candidates];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await check(next);
    }
  });
  await Promise.all(workers);
  return result;
}

export async function loadSnapshot(git: Git, repo: RepoInfo, options: { detectSquashMerged: boolean }): Promise<RepoSnapshot> {
  const cwd = repo.mainPath;
  const [worktrees, branchOutput, remoteOutput, remoteBranchOutput] = await Promise.all([
    listWorktrees(git, cwd),
    git.exec(cwd, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"], { quiet: true }),
    git.exec(cwd, ["remote"], { quiet: true }),
    git.exec(cwd, ["for-each-ref", "--format=%(refname)", "refs/remotes"], { quiet: true }),
  ]);
  const branches = parseBranches(branchOutput).sort((a, b) => a.name.localeCompare(b.name));
  const remotes = remoteOutput.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const remoteBranches = new Set(
    remoteBranchOutput
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter((r) => r.startsWith("refs/remotes/") && !r.endsWith("/HEAD"))
      .map((r) => r.slice("refs/remotes/".length)),
  );
  const { base, defaultRemote } = await findBase(git, cwd, remotes);
  let merged = new Set<string>();
  let contentMerged = new Set<string>();
  if (base) {
    merged = parseMergedBranches(await git.exec(cwd, ["branch", "--merged", base.ref, "--format=%(refname)"], { quiet: true }));
    if (options.detectSquashMerged) {
      const candidates = branches.filter((b) => !merged.has(b.name) && b.name !== base.name);
      contentMerged = await contentMergedBranches(git, cwd, base, candidates);
    }
  }
  const statuses = new Map(branches.map((b) => [b.name, mergeStatus(b, merged, contentMerged)] as const));
  return { repo, worktrees, branches, statuses, base, remotes, defaultRemote, remoteBranches };
}

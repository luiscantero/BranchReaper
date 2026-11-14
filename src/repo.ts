import * as fs from "fs";
import * as path from "path";
import { BRANCH_FORMAT, BranchRef, MergeStatus, isContentMerged, mergeStatus, parseBranches, upstreamToCheck } from "./branches";
import { Git } from "./git";
import { nativePath, pathKey } from "./paths";
import { Worktree, parseWorktreeList } from "./porcelain";
import { protectedBy } from "./protect";

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
  /** Target branch other than the default branch that a merged branch was merged into. */
  mergedInto: Map<string, string>;
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

/** Cache of squash-merge checks, keyed by target and branch commit. */
const contentMergedCache = new Map<string, boolean>();
let mergeTreeSupported = true;

/** Whether the branch's changes are already in the target (squash or cherry-pick merges). */
async function isContentMergedInto(git: Git, cwd: string, target: TargetBranch, sha: string): Promise<boolean> {
  const key = `${target.sha}:${sha}`;
  const cached = contentMergedCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let merged = false;
  if (mergeTreeSupported) {
    const r = await git.run(cwd, ["merge-tree", "--write-tree", "--no-messages", target.sha, sha], { quiet: true });
    if (r.code === 0 || r.code === 1) {
      merged = isContentMerged(r.code, r.stdout, target.tree);
    } else {
      // Git before 2.38: fall back to an empty tree diff.
      mergeTreeSupported = false;
    }
  }
  if (!mergeTreeSupported) {
    merged = (await git.run(cwd, ["diff", "--quiet", target.sha, sha], { quiet: true })).code === 0;
  }
  contentMergedCache.set(key, merged);
  return merged;
}

/** Runs `fn` for every item, at most `limit` at a time. */
async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        await fn(next);
      }
    }),
  );
}

/** A branch that pull requests merge into: the default branch, or one matching `targetBranches`. */
export interface TargetBranch {
  ref: string;
  /** Short name without the remote, for example `release/1.5`. */
  name: string;
  sha: string;
  tree: string;
  committerDate: number;
}

export interface LoadOptions {
  detectSquashMerged: boolean;
  /** Patterns of other branches that pull requests merge into, for example `release/**`. */
  targetBranches: readonly string[];
}

const TARGET_FORMAT = ["%(refname)", "%(objectname)", "%(tree)", "%(committerdate:unix)"].join("%00");

async function findTargets(git: Git, cwd: string, base: BaseBranch, patterns: readonly string[]): Promise<TargetBranch[]> {
  const prefix = base.remote ? `refs/remotes/${base.remote}/` : "refs/heads/";
  const output = await git.exec(cwd, ["for-each-ref", `--format=${TARGET_FORMAT}`, base.remote ? prefix : base.ref], { quiet: true });
  const targets: TargetBranch[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [ref, sha, tree, date] = line.split("\0");
    if (!ref || !tree || ref.endsWith("/HEAD")) {
      continue;
    }
    const name = ref.slice(prefix.length);
    if (ref === base.ref || protectedBy(name, patterns) !== undefined) {
      targets.push({ ref, name, sha, tree, committerDate: Number(date) || 0 });
    }
  }
  // The default branch first: it is the usual target and is reported without its name.
  return targets.sort((a, b) => Number(b.ref === base.ref) - Number(a.ref === base.ref));
}

export async function loadSnapshot(git: Git, repo: RepoInfo, options: LoadOptions): Promise<RepoSnapshot> {
  const cwd = repo.mainPath;
  const [worktrees, branchOutput, remoteOutput, remoteBranchOutput] = await Promise.all([
    listWorktrees(git, cwd),
    git.exec(cwd, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"], { quiet: true }),
    git.exec(cwd, ["remote"], { quiet: true }),
    git.exec(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", "refs/remotes"], { quiet: true }),
  ]);
  const branches = parseBranches(branchOutput).sort((a, b) => a.name.localeCompare(b.name));
  const remotes = remoteOutput.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const remoteTips = new Map<string, { sha: string; committerDate: number }>();
  for (const line of remoteBranchOutput.split(/\r?\n/)) {
    const [ref, sha, date] = line.trim().split("\0");
    if (ref?.startsWith("refs/remotes/") && !ref.endsWith("/HEAD") && sha) {
      remoteTips.set(ref, { sha, committerDate: Number(date) || 0 });
    }
  }
  const remoteBranches = new Set([...remoteTips.keys()].map((r) => r.slice("refs/remotes/".length)));
  // Tips that count as the branch: its own and, when it only lags behind, its upstream's.
  const tipsOf = (branch: BranchRef) => {
    const tips = [{ ref: `refs/heads/${branch.name}`, sha: branch.sha, committerDate: branch.committerDate }];
    const upstream = branch.upstream ? remoteTips.get(branch.upstream) : undefined;
    const upstreamSha = upstreamToCheck(branch, upstream?.sha);
    if (branch.upstream && upstream && upstreamSha) {
      tips.push({ ref: branch.upstream, sha: upstreamSha, committerDate: upstream.committerDate });
    }
    return tips;
  };
  const { base, defaultRemote } = await findBase(git, cwd, remotes);
  const merged = new Set<string>();
  const contentMerged = new Set<string>();
  const mergedInto = new Map<string, string>();
  if (base) {
    const targets = await findTargets(git, cwd, base, options.targetBranches);
    // A branch is never compared with its own upstream or a target of the same name (except the
    // default branch, as before: the local main is merged when origin/main contains it).
    const comparable = (branch: BranchRef, target: TargetBranch) =>
      target.ref === base.ref || (target.ref !== branch.upstream && target.name.toLowerCase() !== branch.name.toLowerCase());
    const record = (branch: BranchRef, target: TargetBranch) => {
      if (target.ref !== base.ref && !mergedInto.has(branch.name)) {
        mergedInto.set(branch.name, target.name);
      }
    };
    const ancestors = new Map<string, Set<string>>();
    await forEachLimited(targets, 8, async (target) => {
      const output = await git.exec(cwd, ["for-each-ref", "--format=%(refname)", "--merged", target.sha, "refs/heads", "refs/remotes"], { quiet: true });
      ancestors.set(target.ref, new Set(output.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)));
    });
    for (const branch of branches) {
      const tips = tipsOf(branch);
      const target = targets.find((t) => comparable(branch, t) && tips.some((tip) => ancestors.get(t.ref)?.has(tip.ref)));
      if (target) {
        merged.add(branch.name);
        record(branch, target);
      }
    }
    if (options.detectSquashMerged) {
      await forEachLimited(
        branches.filter((b) => !merged.has(b.name)),
        8,
        async (branch) => {
          for (const tip of tipsOf(branch)) {
            // Other targets can only contain the changes if they moved after the tip's last commit.
            const candidates = targets.filter((t) => comparable(branch, t) && (t.ref === base.ref || t.committerDate >= tip.committerDate));
            for (const target of candidates) {
              if (await isContentMergedInto(git, cwd, target, tip.sha)) {
                contentMerged.add(branch.name);
                record(branch, target);
                return;
              }
            }
          }
        },
      );
    }
  }
  const statuses = new Map(branches.map((b) => [b.name, mergeStatus(b, merged, contentMerged)] as const));
  return { repo, worktrees, branches, statuses, mergedInto, base, remotes, defaultRemote, remoteBranches };
}
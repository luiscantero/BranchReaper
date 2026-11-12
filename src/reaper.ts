import * as fs from "fs";
import * as path from "path";
import { Git, Logger } from "./git";
import { removeFolderWithRetry } from "./folder";
import { Locker, describeLockers, findLockers } from "./lockers";
import { isInside, nativePath } from "./paths";
import { DeletionPlan, remoteLabel } from "./plan";
import { branchName } from "./porcelain";
import { RepoInfo, listWorktrees } from "./repo";

export interface ReapOptions {
  deleteRemote: boolean;
  retryMs: number;
}

export interface LeftoverFolder {
  path: string;
  error: string;
  lockers: Locker[];
}

export interface ReapResult {
  repo: RepoInfo;
  branch: string;
  branchDeleted: boolean;
  worktreesRemoved: number;
  lockedWorktreesRemoved: number;
  leftovers: LeftoverFolder[];
  remoteDeleted?: string;
  errors: string[];
}

export type StepReporter = (message: string) => void;

/**
 * Deletes a branch with all of its linked worktrees (see README, "How it works"). Callers have
 * already released the worktrees in VS Code windows. Never removes the main worktree.
 */
export async function reapBranch(
  git: Git,
  log: Logger,
  repo: RepoInfo,
  plan: DeletionPlan,
  options: ReapOptions,
  report: StepReporter,
): Promise<ReapResult> {
  const cwd = repo.mainPath;
  const name = plan.branch.name;
  const result: ReapResult = { repo, branch: name, branchDeleted: false, worktreesRemoved: 0, lockedWorktreesRemoved: 0, leftovers: [], errors: [] };
  log.info(`--- Deleting branch ${name} in ${repo.mainPath}`);

  report(`${name}: pruning worktrees`);
  await git.run(cwd, ["worktree", "prune"]);

  // Re-read the worktrees: they may have changed since the plan was made.
  const worktrees = (await listWorktrees(git, cwd)).filter((w) => branchName(w.branch) === name);
  if (worktrees.some((w) => w.main)) {
    result.errors.push(`${name} is checked out in the main worktree`);
    return result;
  }
  const mainPath = repo.bare ? undefined : repo.mainPath;
  for (const worktree of worktrees) {
    const dir = nativePath(worktree.path);
    if (mainPath && isInside(mainPath, dir)) {
      result.errors.push(`Refusing to remove ${dir}: it contains the main worktree`);
      return result;
    }
    report(`${name}: removing worktree ${dir}`);
    const removal = await git.run(cwd, ["worktree", "remove", "--force", "--force", "--", worktree.path]);
    if (fs.existsSync(dir)) {
      report(`${name}: deleting ${dir}`);
      const removed = await removeFolderWithRetry(dir, options.retryMs);
      log.info(removed.removed ? `Deleted ${dir} (${removed.attempts} attempt(s))` : `Could not delete ${dir} after ${removed.attempts} attempt(s): ${removed.error}`);
      if (!removed.removed) {
        report(`${name}: looking for processes using ${dir}`);
        const lockers = await findLockers(dir, log);
        const who = lockers.length > 0 ? `in use by ${describeLockers(lockers)}` : "in use by an unknown process";
        log.error(`${dir} is ${who}${lockers.length ? ":\n" + lockers.map((l) => `  ${l.name} (PID ${l.pid}): ${l.reason}`).join("\n") : ""}`);
        result.leftovers.push({ path: dir, error: removed.error ?? "", lockers });
        // Detach the leftover folder from the repository so the branch can still be deleted.
        await fs.promises.rm(path.join(dir, ".git"), { force: true, recursive: true }).catch(() => undefined);
      }
    }
    if (removal.code !== 0) {
      // A failed `worktree remove` leaves the administrative files (and lock) behind.
      await git.run(cwd, ["worktree", "unlock", "--", worktree.path]);
    }
    if (!fs.existsSync(dir) || removal.code === 0) {
      result.worktreesRemoved++;
      if (worktree.locked) {
        result.lockedWorktreesRemoved++;
      }
    }
  }

  report(`${name}: pruning worktrees`);
  await git.run(cwd, ["worktree", "prune"]);

  report(`${name}: deleting the branch`);
  const deletion = await git.run(cwd, ["branch", "-D", name]);
  if (deletion.code === 0) {
    result.branchDeleted = true;
  } else {
    result.errors.push(`git branch -D ${name}: ${deletion.stderr.trim()}`);
  }

  if (options.deleteRemote && plan.remote && result.branchDeleted) {
    const label = remoteLabel(plan.remote);
    report(`${name}: deleting ${label}`);
    const push = await git.run(cwd, ["push", plan.remote.remote, "--delete", plan.remote.ref], { timeoutMs: 120_000 });
    if (push.code === 0) {
      result.remoteDeleted = label;
    } else if (/remote ref does not exist|unable to delete .*: remote ref/i.test(push.stderr)) {
      log.info(`${label} was already deleted on the remote.`);
      await git.run(cwd, ["branch", "-d", "-r", label]);
    } else {
      result.errors.push(`git push ${plan.remote.remote} --delete ${plan.remote.ref}: ${push.stderr.trim()}`);
    }
  }
  return result;
}

export interface ReapSummary {
  results: ReapResult[];
  /** Branches that were refused, with the reason. */
  skipped: { branch: string; reason: string }[];
  message: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : word.endsWith("ch") ? "es" : "s"}`;

export function summarize(results: readonly ReapResult[], skipped: readonly { branch: string; reason: string }[] = []): string {
  const branches = results.filter((r) => r.branchDeleted).length;
  const worktrees = results.reduce((n, r) => n + r.worktreesRemoved, 0);
  const locked = results.reduce((n, r) => n + r.lockedWorktreesRemoved, 0);
  const remotes = results.filter((r) => r.remoteDeleted).length;
  let message = `Deleted ${plural(branches, "branch")}, ${plural(worktrees, "worktree")}`;
  if (locked > 0) {
    message += ` (${locked} ${locked === 1 ? "was" : "were"} locked)`;
  }
  if (remotes > 0) {
    message += `, ${plural(remotes, "remote branch")}`;
  }
  message += ".";
  const leftovers = results.flatMap((r) => r.leftovers);
  if (leftovers.length > 0) {
    const lockers = leftovers.flatMap((l) => l.lockers);
    message += ` ${plural(leftovers.length, "folder")} could not be deleted${lockers.length ? `, in use by ${describeLockers(lockers)}` : ""}: ${leftovers.map((l) => l.path).join(", ")}.`;
  }
  const failed = results.filter((r) => !r.branchDeleted).length;
  if (failed > 0) {
    message += ` ${plural(failed, "branch")} could not be deleted.`;
  }
  if (skipped.length > 0) {
    message += ` Skipped ${skipped.map((s) => `${s.branch} (${s.reason})`).join(", ")}.`;
  }
  return message;
}

import { BranchRef, MergeStatus } from "./branches";
import { isInside, nativePath } from "./paths";
import { Worktree, branchName } from "./porcelain";
import { protectedBy } from "./protect";

export interface WindowFolder {
  path: string;
  index: number;
}

export interface PlanInput {
  branch: BranchRef;
  status: MergeStatus;
  mergedInto?: string;
  worktrees: readonly Worktree[];
  protectedPatterns: readonly string[];
  /** Short name of the remote's default branch (always protected). */
  defaultBranch?: string;
  /** Workspace folders of the current window. */
  windowFolders: readonly WindowFolder[];
  /** Remote-tracking refs, for example `origin/feature/x`, to find a remote branch without upstream. */
  remoteBranches: ReadonlySet<string>;
  defaultRemote?: string;
}

export interface DeletionPlan {
  branch: BranchRef;
  status: MergeStatus;
  /** Target other than the default branch that it was merged into. */
  mergedInto?: string;
  /** Linked worktrees that have the branch checked out (native paths). */
  worktrees: Worktree[];
  /** Workspace folders of this window inside those worktrees, removed from the window first. */
  windowFoldersToRemove: WindowFolder[];
  /** Remote branch that exists for this branch (deleted only if requested). */
  remote?: { remote: string; ref: string };
}

export type PlanResult = { plan: DeletionPlan } | { refused: string };

export function planDeletion(input: PlanInput): PlanResult {
  const { branch } = input;
  if (input.defaultBranch && branch.name.toLowerCase() === input.defaultBranch.toLowerCase()) {
    return { refused: "the remote's default branch" };
  }
  const pattern = protectedBy(branch.name, input.protectedPatterns);
  if (pattern !== undefined) {
    return { refused: `protected (${pattern})` };
  }
  const checkedOut = input.worktrees.filter((w) => branchName(w.branch) === branch.name);
  if (checkedOut.some((w) => w.main)) {
    return { refused: "checked out in the main worktree" };
  }
  const worktrees = checkedOut.map((w) => ({ ...w, path: nativePath(w.path) }));
  const windowFoldersToRemove: WindowFolder[] = [];
  for (const folder of input.windowFolders) {
    if (worktrees.some((w) => isInside(folder.path, w.path))) {
      windowFoldersToRemove.push(folder);
    }
  }
  if (windowFoldersToRemove.length > 0) {
    if (windowFoldersToRemove.length === input.windowFolders.length) {
      return { refused: "checked out in this window's repository" };
    }
    if (windowFoldersToRemove.some((f) => f.index === 0)) {
      // Removing the first workspace folder restarts all extensions, including this operation.
      return { refused: "its worktree is this window's first workspace folder" };
    }
  }
  let remote: DeletionPlan["remote"];
  if (branch.upstream && !branch.upstreamGone && branch.remote && branch.remoteRef) {
    remote = { remote: branch.remote, ref: branch.remoteRef };
  } else if (!branch.upstream && input.defaultRemote && input.remoteBranches.has(`${input.defaultRemote}/${branch.name}`)) {
    remote = { remote: input.defaultRemote, ref: `refs/heads/${branch.name}` };
  }
  return { plan: { branch, status: input.status, mergedInto: input.mergedInto, worktrees, windowFoldersToRemove, remote } };
}

/** Display name of a remote branch, for example `origin/feature/x`. */
export function remoteLabel(remote: { remote: string; ref: string }): string {
  return `${remote.remote}/${branchName(remote.ref) ?? remote.ref}`;
}

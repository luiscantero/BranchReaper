import * as path from "path";
import * as vscode from "vscode";
import { compareByAge, describeStatus, isMergedStatus, isSafelyMerged, relativeAge } from "./branches";
import { Logger } from "./git";
import { BranchEntry, Model, settings } from "./model";
import { pathKey, shortPath } from "./paths";
import { branchName } from "./porcelain";
import { DeletionPlan, remoteLabel } from "./plan";
import { RepoInfo, RepoSnapshot } from "./repo";
import { ReapResult, ReapSummary, reapBranch, summarize } from "./reaper";
import { OtherWindow, WindowCoordinator, releaseInThisWindow } from "./windows";

export interface Job {
  repo: RepoInfo;
  plan: DeletionPlan;
}

export interface DeleteBranchArgs {
  /** Any folder inside the repository. Defaults to the only repository of the window. */
  repository?: string;
  branch?: string;
  /** Several branches, deleted after one confirmation. */
  branches?: string[];
}

const MAX_DETAIL_LINES = 40;

export class Actions {
  constructor(
    private readonly model: Model,
    private readonly coordinator: WindowCoordinator | undefined,
    private readonly log: Logger & { show(): void },
    private readonly onChanged: () => void,
  ) {}

  /** `Branch Reaper: Delete Branch…`: pick a branch, or delete `args.branch` directly. */
  async deleteBranch(args?: DeleteBranchArgs): Promise<ReapSummary | undefined> {
    const names = args?.branches ?? (args?.branch ? [args.branch] : []);
    if (names.length > 0) {
      const repo = args?.repository ? await this.model.repoFor(args.repository) : (await this.model.repos())[0];
      if (!repo) {
        void vscode.window.showErrorMessage("Branch Reaper: no git repository found.");
        return undefined;
      }
      const all = this.model.entries(await this.model.snapshot(repo));
      const missing = names.filter((n) => !all.some((e) => e.branch.name === n));
      if (missing.length > 0) {
        void vscode.window.showErrorMessage(`Branch Reaper: there is no local branch ${missing.map((n) => `"${n}"`).join(", ")} in ${repo.name}.`);
        return undefined;
      }
      return this.deleteEntries(
        all.filter((e) => names.includes(e.branch.name)),
        { fresh: true },
      );
    }
    const entries = await this.pickBranches();
    return entries.length > 0 ? this.deleteEntries(entries) : undefined;
  }

  /** Context menu of a repository in the Source Control Repositories view. */
  async deleteRepositoryBranch(sourceControl?: { rootUri?: vscode.Uri }): Promise<ReapSummary | undefined> {
    const root = sourceControl?.rootUri;
    if (!root || root.scheme !== "file") {
      return this.deleteBranch();
    }
    const repo = await this.model.repoFor(root.fsPath);
    if (!repo) {
      return this.deleteBranch();
    }
    const snapshot = await this.model.snapshot(repo);
    const worktree = snapshot.worktrees.find((w) => !w.main && pathKey(w.path) === pathKey(root.fsPath));
    const branch = worktree?.branch?.replace(/^refs\/heads\//, "");
    const entry = branch ? this.model.entries(snapshot).find((e) => e.branch.name === branch) : undefined;
    if (entry && "plan" in entry.result) {
      return this.deleteEntries([entry], { fresh: true });
    }
    // The main worktree (or a protected branch): let the user pick branches of this repository.
    const picked = await this.pickBranches([snapshot]);
    return picked.length > 0 ? this.deleteEntries(picked) : undefined;
  }

  /**
   * Deletes the branches after one confirmation. Entries from a list that may be outdated are
   * planned again from the current state of their repositories first.
   */
  async deleteEntries(entries: BranchEntry[], options: { fresh?: boolean; bulk?: boolean } = {}): Promise<ReapSummary | undefined> {
    if (!options.fresh) {
      entries = await this.model.refreshEntries(entries);
    }
    const bulk = options.bulk ?? entries.length > 1;
    const refused = entries.filter((e) => "refused" in e.result);
    if (!bulk) {
      for (const entry of refused) {
        void vscode.window.showWarningMessage(`Branch Reaper: ${entry.branch.name} cannot be deleted: ${"refused" in entry.result ? entry.result.refused : ""}.`);
      }
    }
    const jobs: Job[] = entries.flatMap((e) => ("plan" in e.result ? [{ repo: e.snapshot.repo, plan: e.result.plan }] : []));
    if (jobs.length === 0) {
      return undefined;
    }
    return this.run(
      jobs,
      refused.map((e) => ({ branch: e.branch.name, reason: "refused" in e.result ? e.result.refused : "" })),
      bulk,
    );
  }

  /**
   * Multi-select list of deletable branches. Opens instantly with the last known branches when
   * there are any, and updates when the fresh list is loaded, keeping the checked items.
   */
  private async pickBranches(snapshots?: RepoSnapshot[]): Promise<BranchEntry[]> {
    type Item = vscode.QuickPickItem & { entry: BranchEntry; key: string };
    const quickPick = vscode.window.createQuickPick<Item>();
    quickPick.title = "Branch Reaper: Delete Branches (incl. Worktrees)";
    quickPick.canSelectMany = true;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    let disposed = false;
    const show = (list: RepoSnapshot[]) => {
      if (disposed) {
        return;
      }
      const checked = new Set(quickPick.selectedItems.map((i) => i.key));
      const multiRepo = list.length > 1;
      const merged: Item[] = [];
      const other: Item[] = [];
      let refused = 0;
      for (const snapshot of list) {
        for (const entry of this.model.entries(snapshot)) {
          if ("refused" in entry.result) {
            refused++;
            continue;
          }
          const item = { ...branchItem(entry, multiRepo), key: `${snapshot.repo.key}\0${entry.branch.name}` };
          (isSafelyMerged(statusOf(entry)) ? merged : other).push(item);
        }
      }
      const byAge = (a: Item, b: Item) => compareByAge(a.entry.branch, b.entry.branch);
      const separator = (label: string) => ({ label, kind: vscode.QuickPickItemKind.Separator }) as Item;
      const items: Item[] = [];
      if (merged.length > 0) {
        items.push(separator("Merged"), ...merged.sort(byAge));
      }
      if (other.length > 0) {
        items.push(separator("Unmerged or upstream gone"), ...other.sort(byAge));
      }
      quickPick.items = items;
      quickPick.selectedItems = items.filter((i) => i.key && checked.has(i.key));
      quickPick.placeholder =
        list.length === 0
          ? "No git repository found in this window."
          : `Check the branches to delete with all of their worktrees, then press Enter${refused ? ` (${refused} protected or in-use branch${refused === 1 ? " is" : "es are"} not listed)` : ""}`;
    };
    const cached = snapshots ?? this.model.cached;
    if (cached) {
      show(cached);
    }
    quickPick.busy = true;
    quickPick.show();
    const loading = (snapshots ? Promise.resolve(snapshots) : this.model.snapshots())
      .then((list) => show(list))
      .catch((e) => {
        this.log.error(`Loading branches failed: ${(e as Error).message}`);
        void vscode.window.showErrorMessage(`Branch Reaper: ${(e as Error).message}`);
      })
      .finally(() => (quickPick.busy = false));
    const picked = await new Promise<BranchEntry[]>((resolve) => {
      quickPick.onDidAccept(() => {
        // Enter without checking anything deletes the highlighted branch.
        const items = quickPick.selectedItems.length > 0 ? quickPick.selectedItems : quickPick.activeItems.slice(0, 1);
        if (items.length === 0) {
          return;
        }
        resolve(items.map((i) => i.entry));
        quickPick.hide();
      });
      quickPick.onDidHide(() => resolve([]));
    });
    if (picked.length === 0) {
      await loading;
    }
    disposed = true;
    quickPick.dispose();
    return picked;
  }
  /** `Branch Reaper: Clean Up Merged Branches`. */
  async cleanUpMerged(): Promise<ReapSummary | undefined> {
    const config = settings();
    const git = await this.model.git();
    const snapshots = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Branch Reaper", cancellable: false },
      async (progress) => {
        const repos = await this.model.repos();
        if (config.fetch) {
          for (const repo of repos) {
            progress.report({ message: `Fetching ${repo.name}…` });
            const remotes = (await git.run(repo.mainPath, ["remote"], { quiet: true })).stdout.trim();
            if (remotes) {
              const fetched = await git.run(repo.mainPath, ["fetch", "--prune"], { timeoutMs: 180_000 });
              if (fetched.code !== 0) {
                void vscode.window.showWarningMessage(`Branch Reaper: git fetch failed in ${repo.name}, using the remote branches known locally. See the log for details.`);
              }
            }
          }
        }
        progress.report({ message: "Finding merged branches…" });
        return this.model.snapshots(repos);
      },
    );
    const multiRepo = snapshots.length > 1;
    const candidates = snapshots
      .flatMap((s) => this.model.entries(s))
      .filter((e) => "plan" in e.result && isMergedStatus(e.result.plan.status))
      .sort((a, b) => compareByAge(a.branch, b.branch));
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage("Branch Reaper: no merged branches to clean up.");
      return undefined;
    }
    const dirty = await this.dirtyWorktrees(candidates.flatMap((e) => ("plan" in e.result ? e.result.plan.worktrees.map((w) => w.path) : [])));
    type Item = vscode.QuickPickItem & { entry: BranchEntry };
    const items: Item[] = candidates.map((entry) => {
      const item = branchItem(entry, multiRepo) as Item;
      const hasDirty = "plan" in entry.result && entry.result.plan.worktrees.some((w) => dirty.has(w.path));
      // Worktrees with uncommitted changes may belong to a session that is still running, and a
      // gone upstream alone does not prove that the changes were merged: leave those unchecked.
      const safe = isSafelyMerged(statusOf(entry));
      item.picked = !hasDirty && safe;
      const warnings = [hasDirty ? "uncommitted changes" : undefined, safe ? undefined : "changes not found in the default branch"].filter(Boolean);
      if (warnings.length > 0) {
        item.detail = `$(warning) ${warnings.join(", ")} · ${item.detail ?? ""}`;
      }
      return item;
    });
    const selected = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: "Branch Reaper: Clean Up Merged Branches",
      placeHolder: "Branches merged into the default branch or whose upstream is gone. Uncheck the ones to keep.",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selected || selected.length === 0) {
      return undefined;
    }
    return this.deleteEntries(
      selected.map((s) => s.entry),
      { fresh: true, bulk: true },
    );
  }

  private async dirtyWorktrees(paths: string[]): Promise<Set<string>> {
    const git = await this.model.git();
    const dirty = new Set<string>();
    await Promise.all(
      paths.map(async (p) => {
        const status = await git.run(p, ["status", "--porcelain", "--untracked-files=normal"], { quiet: true }).catch(() => undefined);
        if (status && status.code === 0 && status.stdout.trim() !== "") {
          dirty.add(p);
        }
      }),
    );
    return dirty;
  }

  /** Confirms once, releases the worktrees in all windows, then deletes everything with progress. */
  private async run(jobs: Job[], skipped: { branch: string; reason: string }[], bulk: boolean): Promise<ReapSummary | undefined> {
    const config = settings();
    const paths = jobs.flatMap((j) => j.plan.worktrees.map((w) => w.path));
    const others = this.coordinator ? await this.coordinator.otherWindows(paths) : [];
    let deleteRemote = config.deleteRemote === "always";
    if (config.confirm) {
      const dirty = await this.dirtyWorktrees(jobs.flatMap((j) => j.plan.worktrees.filter((w) => !w.prunable).map((w) => w.path)));
      const choice = await confirm(jobs, others, dirty, config.deleteRemote, bulk);
      if (!choice) {
        return undefined;
      }
      deleteRemote = choice === "withRemote" || config.deleteRemote === "always";
    }

    const results: ReapResult[] = [];
    const git = await this.model.git();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Branch Reaper", cancellable: jobs.length > 1 },
      async (progress, token) => {
        if (paths.length > 0) {
          progress.report({ message: "Releasing worktrees in VS Code windows…" });
          const own = await releaseInThisWindow(paths, { closeTerminals: config.closeTerminals, removeFolders: true });
          if (own.removedFolders || own.closedTerminals) {
            this.log.info(`This window: removed ${own.removedFolders} workspace folder(s), closed ${own.closedTerminals} terminal(s).`);
          }
          await this.coordinator?.releaseInOtherWindows(paths, config.closeTerminals);
        }
        const increment = 100 / jobs.length;
        for (const job of jobs) {
          if (token.isCancellationRequested) {
            skipped.push({ branch: job.plan.branch.name, reason: "cancelled" });
            continue;
          }
          const result = await reapBranch(
            git,
            this.log,
            job.repo,
            job.plan,
            { deleteRemote, retryMs: config.retryMs },
            (message) => progress.report({ message }),
          );
          results.push(result);
          progress.report({ increment });
        }
      },
    );
    const message = summarize(results, skipped);
    this.log.info(message);
    for (const error of results.flatMap((r) => r.errors)) {
      this.log.error(error);
    }
    const problems = results.some((r) => r.leftovers.length > 0 || r.errors.length > 0 || !r.branchDeleted);
    const show = problems ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`Branch Reaper: ${message}`, "Show Log").then((action) => action && this.log.show());
    this.onChanged();
    return { results, skipped, message };
  }
}

function statusOf(entry: BranchEntry) {
  return entry.snapshot.statuses.get(entry.branch.name) ?? "unmerged";
}

function branchItem(entry: BranchEntry, multiRepo: boolean): vscode.QuickPickItem & { entry: BranchEntry } {
  const status = entry.snapshot.statuses.get(entry.branch.name) ?? "unmerged";
  const worktrees = entry.snapshot.worktrees.filter((w) => w.branch === `refs/heads/${entry.branch.name}`);
  const locked = worktrees.some((w) => w.locked);
  const icon = "refused" in entry.result ? "$(shield)" : locked ? "$(lock)" : "$(git-branch)";
  const description = [
    describeStatus(status),
    relativeAge(entry.branch.committerDate),
    "refused" in entry.result ? entry.result.refused : undefined,
    multiRepo ? entry.snapshot.repo.name : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const detail =
    worktrees.length === 0
      ? "no worktree"
      : worktrees
          .map((w) => `${w.locked ? "$(lock) locked " : "$(folder) "}${w.main ? "main worktree " : "worktree "}${path.normalize(w.path)}${w.prunable ? " (missing)" : ""}`)
          .join("  ");
  return { label: `${icon} ${entry.branch.name}`, description, detail, entry };
}

async function confirm(
  jobs: Job[],
  others: OtherWindow[],
  dirty: Set<string>,
  deleteRemote: "never" | "ask" | "always",
  bulk: boolean,
): Promise<"local" | "withRemote" | undefined> {
  // One block per branch, separated by a blank line; paths shortened to `C:\…\folder`.
  const blocks: string[][] = [];
  const remotes = jobs.filter((j) => j.plan.remote);
  const multiRepo = new Set(jobs.map((j) => j.repo.key)).size > 1;
  for (const job of jobs) {
    const { plan } = job;
    const flags = (w: DeletionPlan["worktrees"][number]) =>
      [w.locked ? "locked" : undefined, dirty.has(w.path) ? "uncommitted changes" : undefined, w.prunable ? "folder missing" : undefined].filter(Boolean).join(", ");
    const block = [`Branch ${plan.branch.name} (${describeStatus(plan.status)}${multiRepo ? `, ${job.repo.name}` : ""})`];
    for (const worktree of plan.worktrees) {
      const f = flags(worktree);
      block.push(`    Worktree ${shortPath(worktree.path)}${f ? ` (${f})` : ""}`);
    }
    if (plan.remote && deleteRemote !== "never") {
      const sameName = branchName(plan.remote.ref) === plan.branch.name;
      block.push(`    Remote branch ${sameName ? `on ${plan.remote.remote}` : remoteLabel(plan.remote)}${deleteRemote === "ask" ? " *" : ""}`);
    }
    blocks.push(block);
  }
  const windowLines: string[] = [];
  for (const job of jobs) {
    for (const folder of job.plan.windowFoldersToRemove) {
      windowLines.push(`${shortPath(folder.path)} will be removed from this window.`);
    }
  }
  for (const other of others) {
    const folders = other.folders.map((f) => shortPath(f)).join(", ");
    if (!other.managed) {
      windowLines.push(`${folders} is open in a VS Code window that cannot be closed automatically; close it first.`);
    } else if (other.willClose) {
      windowLines.push(`The VS Code window on ${folders} will be closed.`);
    } else {
      windowLines.push(`${folders} will be removed from another VS Code window.`);
    }
  }
  const shown: string[][] = [];
  let lineCount = 0;
  for (const block of blocks) {
    if (lineCount + block.length > MAX_DETAIL_LINES && shown.length > 0) {
      break;
    }
    shown.push(block);
    lineCount += block.length;
  }
  let detail = shown.map((b) => b.join("\n")).join("\n\n");
  if (shown.length < blocks.length) {
    detail += `\n\n… and ${blocks.length - shown.length} more branch${blocks.length - shown.length === 1 ? "" : "es"}`;
  }
  if (windowLines.length > 0) {
    detail += `\n\n${windowLines.join("\n")}`;
  }
  const notes = ["Worktree folders are deleted with all their files, including uncommitted and ignored ones."];
  if (deleteRemote === "ask" && remotes.length > 0) {
    notes.unshift('* Only deleted with "Delete incl. Remote".');
  }
  detail += `\n\n${notes.join("\n")}`;
  const worktreeCount = jobs.reduce((n, j) => n + j.plan.worktrees.length, 0);
  const message =
    jobs.length === 1 && !bulk
      ? `Delete branch "${jobs[0].plan.branch.name}"${worktreeCount ? ` and ${worktreeCount === 1 ? "its worktree" : `its ${worktreeCount} worktrees`}` : ""}?`
      : `Delete ${jobs.length} branches${worktreeCount ? ` and ${worktreeCount} worktree${worktreeCount === 1 ? "" : "s"}` : ""}?`;
  const buttons = deleteRemote === "ask" && remotes.length > 0 ? ["Delete", "Delete incl. Remote"] : ["Delete"];
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, ...buttons);
  return choice === "Delete" ? "local" : choice === "Delete incl. Remote" ? "withRemote" : undefined;
}

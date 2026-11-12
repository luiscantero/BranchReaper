import * as path from "path";
import * as vscode from "vscode";
import { Actions, DeleteBranchArgs } from "./actions";
import { Model } from "./model";
import { BranchTree, Node } from "./tree";
import { GitRepositoryApi, WindowCoordinator, getGitApi } from "./windows";

/** `<user data>/User/globalStorage`, where VS Code keeps `storage.json` (also with profiles). */
function userGlobalStorage(context: vscode.ExtensionContext): string | undefined {
  let dir = context.globalStorageUri.fsPath;
  while (path.dirname(dir) !== dir) {
    if (path.basename(dir) === "User") {
      return path.join(dir, "globalStorage");
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("Branch Reaper", { log: true });
  context.subscriptions.push(log);

  let coordinator: WindowCoordinator | undefined = new WindowCoordinator(log, userGlobalStorage(context));
  try {
    await coordinator.start();
    context.subscriptions.push(coordinator);
  } catch (e) {
    log.warn(`Coordinating with other VS Code windows is not available: ${(e as Error).message}`);
    coordinator = undefined;
  }

  const model = new Model(log);
  const tree = new BranchTree(model);
  const view = vscode.window.createTreeView("branchReaper.branches", {
    treeDataProvider: tree,
    canSelectMany: true,
    showCollapseAll: true,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(view);
  const showChecked = (count: number) => {
    view.description = count > 0 ? `${count} checked` : undefined;
    void vscode.commands.executeCommand("setContext", "branchReaper.checkedCount", count);
  };
  showChecked(0);
  context.subscriptions.push(
    view.onDidChangeCheckboxState((e) => tree.setChecked(e.items)),
    tree.onDidChangeChecked(showChecked),
  );

  let stale = false;
  let timer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      if (view.visible) {
        tree.refresh();
      } else {
        stale = true;
      }
    }, 1500);
  };
  context.subscriptions.push(
    { dispose: () => timer && clearTimeout(timer) },
    view.onDidChangeVisibility((e) => {
      if (e.visible && stale) {
        stale = false;
        tree.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("branchReaper") && scheduleRefresh()),
  );

  const actions = new Actions(model, coordinator, log, () => tree.refresh());
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R | undefined> => {
      try {
        return await fn(...args);
      } catch (e) {
        log.error(`${(e as Error).stack ?? e}`);
        void vscode.window.showErrorMessage(`Branch Reaper: ${(e as Error).message}`, "Show Log").then((a) => a && log.show());
        return undefined;
      }
    };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "branchReaper.deleteBranch",
      guard((args?: DeleteBranchArgs) => actions.deleteBranch(args)),
    ),
    vscode.commands.registerCommand(
      "branchReaper.cleanUpMerged",
      guard(() => actions.cleanUpMerged()),
    ),
    vscode.commands.registerCommand(
      "branchReaper.deleteBranchItem",
      guard(async (node?: Node, selected?: Node[]) => {
        const nodes = selected && selected.length > 0 ? selected : node ? [node] : [...view.selection];
        const entries = nodes.flatMap((n) => (n.kind === "branch" ? [n.entry] : []));
        return entries.length > 0 ? actions.deleteEntries(entries) : actions.deleteBranch();
      }),
    ),
    vscode.commands.registerCommand(
      "branchReaper.deleteChecked",
      guard(async () => {
        const entries = await tree.checkedEntries();
        if (entries.length === 0) {
          void vscode.window.showInformationMessage("Branch Reaper: check the branches to delete in the Branches & Worktrees view first.");
          return undefined;
        }
        const summary = await actions.deleteEntries(entries, { bulk: true });
        if (summary) {
          tree.uncheckAll();
        }
        return summary;
      }),
    ),
    vscode.commands.registerCommand("branchReaper.checkMerged", guard(() => tree.checkMerged())),
    vscode.commands.registerCommand("branchReaper.uncheckAll", () => tree.uncheckAll()),
    vscode.commands.registerCommand(
      "branchReaper.deleteRepositoryBranch",
      guard((sourceControl?: { rootUri?: vscode.Uri }) => actions.deleteRepositoryBranch(sourceControl)),
    ),
    vscode.commands.registerCommand("branchReaper.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("branchReaper.revealWorktree", (node?: Node) => {
      if (node?.kind === "worktree") {
        void vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path.normalize(node.worktree.path)), { forceNewWindow: true });
      }
    }),
    vscode.commands.registerCommand("branchReaper.showLog", () => log.show()),
  );

  // Refresh the tree when repositories change; the git extension may activate after this one.
  void getGitApi().then((api) => {
    if (!api) {
      return;
    }
    const watch = (repository: GitRepositoryApi) => context.subscriptions.push(repository.state.onDidChange(scheduleRefresh));
    api.repositories.forEach(watch);
    context.subscriptions.push(
      api.onDidOpenRepository((repository) => {
        watch(repository);
        scheduleRefresh();
      }),
      api.onDidCloseRepository(scheduleRefresh),
    );
    scheduleRefresh();
    // Load the branches once in the background, so the first Delete Branch… list opens instantly.
    setTimeout(() => {
      if (!model.cached && !view.visible) {
        void model.snapshots().catch(() => undefined);
      }
    }, 3000);
  });
}

export function deactivate() {
  // Disposables registered on the context clean up the window registration.
}

import * as path from "path";
import * as vscode from "vscode";
import { compareByAge, describeStatus, isSafelyMerged, relativeAge, shortBranchLabels } from "./branches";
import { BranchEntry, Model } from "./model";
import { Worktree, branchName } from "./porcelain";
import { RepoSnapshot } from "./repo";

type GroupKind = "merged" | "unmerged" | "refused";

export type Node =
  | { kind: "repo"; snapshot: RepoSnapshot }
  | { kind: "group"; group: GroupKind; snapshot: RepoSnapshot; entries: BranchEntry[] }
  | { kind: "branch"; entry: BranchEntry; label: string; worktrees: Worktree[] }
  | { kind: "worktree"; worktree: Worktree }
  | { kind: "message"; text: string };

const GROUP_LABELS: Record<GroupKind, string> = {
  merged: "Merged",
  unmerged: "Unmerged or upstream gone",
  refused: "Protected or in use",
};

const entryKey = (entry: BranchEntry) => `${entry.snapshot.repo.key}\0${entry.branch.name}`;

export class BranchTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly checkedChanged = new vscode.EventEmitter<number>();
  /** Fires the number of checked branches. */
  readonly onDidChangeChecked = this.checkedChanged.event;
  private snapshots?: Promise<RepoSnapshot[]>;
  /** Checked branches, kept across refreshes while they can still be deleted. */
  private readonly checked = new Set<string>();

  constructor(private readonly model: Model) {}

  refresh() {
    this.snapshots = undefined;
    this.changed.fire(undefined);
  }

  get checkedCount(): number {
    return this.checked.size;
  }

  /** Applies checkbox changes; checking a group checks all of its branches. */
  setChecked(changes: readonly (readonly [Node, vscode.TreeItemCheckboxState])[]) {
    for (const [node, state] of changes) {
      const entries = node.kind === "branch" ? [node.entry] : node.kind === "group" ? node.entries : [];
      for (const entry of entries.filter((e) => "plan" in e.result)) {
        if (state === vscode.TreeItemCheckboxState.Checked) {
          this.checked.add(entryKey(entry));
        } else {
          this.checked.delete(entryKey(entry));
        }
      }
    }
    this.checkedChanged.fire(this.checked.size);
    // Redraw without reloading: group checkboxes depend on their branches.
    this.changed.fire(undefined);
  }

  async checkMerged() {
    for (const snapshot of await this.currentSnapshots()) {
      for (const entry of this.model.entries(snapshot)) {
        if ("plan" in entry.result && isSafelyMerged(entry.result.plan.status)) {
          this.checked.add(entryKey(entry));
        }
      }
    }
    this.checkedChanged.fire(this.checked.size);
    this.changed.fire(undefined);
  }

  uncheckAll() {
    this.checked.clear();
    this.checkedChanged.fire(0);
    this.changed.fire(undefined);
  }

  async checkedEntries(): Promise<BranchEntry[]> {
    return (await this.currentSnapshots()).flatMap((s) => this.model.entries(s)).filter((e) => this.checked.has(entryKey(e)));
  }

  private currentSnapshots(): Promise<RepoSnapshot[]> {
    this.snapshots ??= this.model.snapshots().then((snapshots) => {
      // Forget checked branches that no longer exist or can no longer be deleted.
      const deletable = new Set(snapshots.flatMap((s) => this.model.entries(s)).filter((e) => "plan" in e.result).map(entryKey));
      const before = this.checked.size;
      for (const key of [...this.checked]) {
        if (!deletable.has(key)) {
          this.checked.delete(key);
        }
      }
      if (this.checked.size !== before) {
        this.checkedChanged.fire(this.checked.size);
      }
      return snapshots;
    });
    return this.snapshots;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "repo": {
        const item = new vscode.TreeItem(node.snapshot.repo.name, vscode.TreeItemCollapsibleState.Expanded);
        item.description = node.snapshot.repo.mainPath;
        item.iconPath = new vscode.ThemeIcon("repo");
        item.contextValue = "repository";
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(
          GROUP_LABELS[node.group],
          node.group === "refused" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.description = String(node.entries.length);
        item.id = `${node.snapshot.repo.key}:${node.group}`;
        // Only the merged group can be checked as a whole; unmerged branches are checked one by one.
        if (node.group === "merged") {
          item.checkboxState = node.entries.every((e) => this.checked.has(entryKey(e)))
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        }
        item.contextValue = `group.${node.group}`;
        return item;
      }
      case "branch": {
        const { entry, worktrees } = node;
        const status = entry.snapshot.statuses.get(entry.branch.name) ?? "unmerged";
        const item = new vscode.TreeItem(
          node.label,
          worktrees.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        item.id = `${entry.snapshot.repo.key}:branch:${entry.branch.name}`;
        const locked = worktrees.some((w) => w.locked);
        const into = entry.snapshot.mergedInto.get(entry.branch.name);
        const parts = [describeStatus(status, into), relativeAge(entry.branch.committerDate)];
        if ("refused" in entry.result) {
          parts.push(entry.result.refused);
        }
        if (worktrees.length === 1) {
          const folder = path.basename(path.normalize(worktrees[0].path));
          if (folder.toLowerCase() !== node.label.toLowerCase()) {
            parts.push(folder);
          }
        } else if (worktrees.length > 1) {
          parts.push(`${worktrees.length} worktrees`);
        }
        item.description = parts.join(" · ");
        item.iconPath = new vscode.ThemeIcon("refused" in entry.result ? "shield" : locked ? "lock" : "git-branch");
        const tooltip = new vscode.MarkdownString(undefined, true);
        tooltip.appendMarkdown(`**${escape(entry.branch.name)}** · ${describeStatus(status, into)}\n\n`);
        tooltip.appendMarkdown(`${escape(entry.branch.subject)}\n\n`);
        if (entry.branch.upstream) {
          tooltip.appendMarkdown(`Upstream: ${escape(entry.branch.upstream.replace(/^refs\/remotes\//, ""))}${entry.branch.upstreamGone ? " (gone)" : ""}\n\n`);
        }
        for (const w of worktrees) {
          tooltip.appendMarkdown(`$(${w.locked ? "lock" : "folder"}) ${escape(path.normalize(w.path))}${w.lockReason ? ` — ${escape(w.lockReason)}` : ""}\n\n`);
        }
        if ("refused" in entry.result) {
          tooltip.appendMarkdown(`Cannot be deleted: ${escape(entry.result.refused)}`);
        }
        item.tooltip = tooltip;
        item.contextValue = "plan" in entry.result ? "branch.deletable" : "branch.protected";
        if ("plan" in entry.result) {
          item.checkboxState = this.checked.has(entryKey(entry)) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        }
        return item;
      }
      case "worktree": {
        const { worktree } = node;
        const dir = path.normalize(worktree.path);
        const item = new vscode.TreeItem(path.basename(dir), vscode.TreeItemCollapsibleState.None);
        item.description = [worktree.main ? "main worktree" : undefined, worktree.locked ? "locked" : undefined, worktree.prunable ? "missing" : undefined, dir]
          .filter(Boolean)
          .join(" · ");
        item.iconPath = new vscode.ThemeIcon(worktree.locked ? "lock" : worktree.prunable ? "warning" : "folder");
        item.tooltip = `${dir}${worktree.lockReason ? `\nLocked: ${worktree.lockReason}` : worktree.locked ? "\nLocked" : ""}`;
        item.resourceUri = vscode.Uri.file(dir);
        item.contextValue = worktree.prunable ? "worktree.missing" : "worktree";
        return item;
      }
      case "message":
        return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const snapshots = await this.currentSnapshots();
      if (snapshots.length === 0) {
        return [];
      }
      return snapshots.length === 1 ? this.groups(snapshots[0]) : snapshots.map((snapshot) => ({ kind: "repo", snapshot }));
    }
    switch (node.kind) {
      case "repo":
        return this.groups(node.snapshot);
      case "group": {
        // Unique across the whole repository, so that labels in different groups do not look alike.
        const labels = shortBranchLabels(node.snapshot.branches.map((b) => b.name));
        return node.entries.map((entry) => ({
          kind: "branch",
          entry,
          label: labels.get(entry.branch.name) ?? entry.branch.name,
          worktrees: entry.snapshot.worktrees.filter((w) => branchName(w.branch) === entry.branch.name),
        }));
      }
      case "branch":
        return node.worktrees.map((worktree) => ({ kind: "worktree", worktree }));
      default:
        return [];
    }
  }

  private groups(snapshot: RepoSnapshot): Node[] {
    const entries = this.model.entries(snapshot);
    const groups: Record<GroupKind, BranchEntry[]> = { merged: [], unmerged: [], refused: [] };
    for (const entry of entries) {
      if ("refused" in entry.result) {
        groups.refused.push(entry);
      } else {
        groups[isSafelyMerged(entry.result.plan.status) ? "merged" : "unmerged"].push(entry);
      }
    }
    for (const list of Object.values(groups)) {
      list.sort((a, b) => compareByAge(a.branch, b.branch));
    }
    const nodes: Node[] = (Object.keys(groups) as GroupKind[])
      .filter((group) => groups[group].length > 0)
      .map((group) => ({ kind: "group", group, snapshot, entries: groups[group] }));
    return nodes.length > 0 ? nodes : [{ kind: "message", text: "No local branches." }];
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

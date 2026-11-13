import * as vscode from "vscode";
import { BranchRef } from "./branches";
import { Git, Logger } from "./git";
import { PlanResult, WindowFolder, planDeletion } from "./plan";
import { RepoInfo, RepoSnapshot, loadSnapshot, resolveRepo } from "./repo";
import { getGitApi } from "./windows";

export type DeleteRemote = "never" | "ask" | "always";

const DEFAULT_TARGET_BRANCHES = ["main", "master", "develop", "dev", "preview", "release*", "release/**", "releases/**", "hotfix/**"];

export interface Settings {
  protectedBranches: string[];
  deleteRemote: DeleteRemote;
  confirm: boolean;
  retryMs: number;
  detectSquashMerged: boolean;
  targetBranches: string[];
  fetch: boolean;
  closeTerminals: boolean;
}

export function settings(): Settings {
  const config = vscode.workspace.getConfiguration("branchReaper");
  return {
    protectedBranches: config.get<string[]>("protectedBranches", ["main", "master", "release*", "releases/*"]),
    deleteRemote: config.get<DeleteRemote>("deleteRemote", "ask"),
    confirm: config.get<boolean>("confirm", true),
    retryMs: Math.max(0, config.get<number>("worktreeDeleteRetryMs", 5000)),
    detectSquashMerged: config.get<boolean>("cleanUp.detectSquashMerged", true),
    targetBranches: config.get<string[]>("targetBranches", DEFAULT_TARGET_BRANCHES),
    fetch: config.get<boolean>("cleanUp.fetch", true),
    closeTerminals: config.get<boolean>("closeTerminals", true),
  };
}

export function windowFolders(): WindowFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => ({ path: f.uri.fsPath, index: f.index }));
}

export interface BranchEntry {
  snapshot: RepoSnapshot;
  branch: BranchRef;
  result: PlanResult;
}

export class Model {
  private gitPromise?: Promise<Git>;

  constructor(private readonly log: Logger) {}

  git(): Promise<Git> {
    this.gitPromise ??= getGitApi().then((api) => new Git(api?.git.path || "git", this.log));
    return this.gitPromise;
  }

  /** Repositories of this window (open in the git extension or workspace folders), one per common dir. */
  async repos(): Promise<RepoInfo[]> {
    const git = await this.git();
    const api = await getGitApi();
    const candidates = new Set<string>();
    for (const repository of api?.repositories ?? []) {
      candidates.add(repository.rootUri.fsPath);
    }
    for (const folder of windowFolders()) {
      candidates.add(folder.path);
    }
    const resolved = await Promise.all([...candidates].map((dir) => resolveRepo(git, dir).catch(() => undefined)));
    const byKey = new Map<string, RepoInfo>();
    for (const repo of resolved) {
      if (repo && !byKey.has(repo.key)) {
        byKey.set(repo.key, repo);
      }
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async repoFor(dir: string): Promise<RepoInfo | undefined> {
    return resolveRepo(await this.git(), dir);
  }

  async snapshot(repo: RepoInfo): Promise<RepoSnapshot> {
    return loadSnapshot(await this.git(), repo, { detectSquashMerged: settings().detectSquashMerged, targetBranches: settings().targetBranches });
  }

  /** Snapshots of the last full load of all repositories, shown while a fresh load runs. */
  private lastAll?: RepoSnapshot[];

  get cached(): RepoSnapshot[] | undefined {
    return this.lastAll;
  }

  async snapshots(repos?: RepoInfo[]): Promise<RepoSnapshot[]> {
    const list = repos ?? (await this.repos());
    const results = await Promise.all(
      list.map((repo) =>
        this.snapshot(repo).catch((e) => {
          this.log.error(`Could not read ${repo.mainPath}: ${(e as Error).message}`);
          return undefined;
        }),
      ),
    );
    const snapshots = results.filter((s): s is RepoSnapshot => !!s);
    if (!repos) {
      this.lastAll = snapshots;
    }
    return snapshots;
  }

  /** Fresh entries for the same branches (repositories change between listing and deleting). */
  async refreshEntries(entries: readonly BranchEntry[]): Promise<BranchEntry[]> {
    const repos = new Map(entries.map((e) => [e.snapshot.repo.key, e.snapshot.repo]));
    const fresh = await this.snapshots([...repos.values()]);
    const byKey = new Map(fresh.flatMap((s) => this.entries(s)).map((e) => [`${e.snapshot.repo.key}\0${e.branch.name}`, e]));
    return entries.flatMap((e) => byKey.get(`${e.snapshot.repo.key}\0${e.branch.name}`) ?? []);
  }

  entries(snapshot: RepoSnapshot): BranchEntry[] {
    const config = settings();
    const folders = windowFolders();
    return snapshot.branches.map((branch) => ({
      snapshot,
      branch,
      result: planDeletion({
        branch,
        status: snapshot.statuses.get(branch.name) ?? "unmerged",
        mergedInto: snapshot.mergedInto.get(branch.name),
        worktrees: snapshot.worktrees,
        protectedPatterns: config.protectedBranches,
        defaultBranch: snapshot.base?.name,
        windowFolders: folders,
        remoteBranches: snapshot.remoteBranches,
        defaultRemote: snapshot.defaultRemote,
      }),
    }));
  }
}

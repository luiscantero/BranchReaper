import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { Logger } from "./git";
import { isInside, pathKey } from "./paths";

/** What a window registered itself with. */
interface WindowEntry {
  id: string;
  pid: number;
  folders: string[];
  updated: number;
}

interface ReleaseRequest {
  id: string;
  from: string;
  paths: string[];
  closeTerminals: boolean;
}

export interface ReleaseReply {
  window: string;
  /** `closing`: the window closes itself; `removed`: folders were removed from it. */
  action: "closing" | "removed" | "released" | "none";
  closedTerminals: number;
  error?: string;
}

/** Another VS Code window with a workspace folder inside one of the paths. */
export interface OtherWindow {
  folders: string[];
  /** Whether Branch Reaper runs in that window and can release the folders itself. */
  managed: boolean;
  /** All of its folders are affected, so the window will be closed. */
  willClose: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(value));
  await fs.promises.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function uriToPath(uri: string): string | undefined {
  try {
    const parsed = vscode.Uri.parse(uri);
    return parsed.scheme === "file" ? parsed.fsPath : undefined;
  } catch {
    return undefined;
  }
}

/** Working directory of a terminal, if known. */
function terminalCwd(terminal: vscode.Terminal): string | undefined {
  const fromShell = terminal.shellIntegration?.cwd;
  if (fromShell?.scheme === "file") {
    return fromShell.fsPath;
  }
  const options = terminal.creationOptions as vscode.TerminalOptions;
  const cwd = options?.cwd;
  if (typeof cwd === "string") {
    return cwd;
  }
  return cwd?.scheme === "file" ? cwd.fsPath : undefined;
}

/**
 * Lets Branch Reaper instances in different VS Code windows (also of other VS Code instances of
 * the same user) find each other and ask each other to let go of worktrees: every window
 * registers its workspace folders in a per-user temp directory and watches an inbox there.
 */
export class WindowCoordinator implements vscode.Disposable {
  private readonly root: string;
  private readonly windowsDir: string;
  private readonly inbox: string;
  private readonly repliesDir: string;
  readonly id = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  private watcher?: fs.FSWatcher;
  private poll?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];
  private handling = new Set<string>();

  constructor(
    private readonly log: Logger,
    private readonly userDataGlobalStorage: string | undefined,
  ) {
    let user = "user";
    try {
      user = process.platform === "win32" ? os.userInfo().username : String(os.userInfo().uid);
    } catch {
      // keep the default
    }
    this.root = path.join(os.tmpdir(), `branch-reaper-${user.replace(/[^\w.-]/g, "_")}`);
    this.windowsDir = path.join(this.root, "windows");
    this.inbox = path.join(this.root, "inbox", this.id);
    this.repliesDir = path.join(this.root, "replies");
  }

  async start() {
    for (const dir of [this.windowsDir, this.inbox, this.repliesDir]) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await this.register();
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.register()));
    try {
      this.watcher = fs.watch(this.inbox, () => void this.processInbox());
      this.watcher.on("error", () => undefined);
    } catch {
      // polling below still works
    }
    this.poll = setInterval(() => void this.processInbox(), 1000);
    void this.cleanStale();
  }

  dispose() {
    this.watcher?.close();
    if (this.poll) {
      clearInterval(this.poll);
    }
    this.disposables.forEach((d) => d.dispose());
    try {
      fs.rmSync(path.join(this.windowsDir, `${this.id}.json`), { force: true });
      fs.rmSync(this.inbox, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  private async register() {
    const entry: WindowEntry = {
      id: this.id,
      pid: process.pid,
      folders: (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath),
      updated: Date.now(),
    };
    await writeJsonAtomic(path.join(this.windowsDir, `${this.id}.json`), entry);
  }

  private async entries(): Promise<WindowEntry[]> {
    let files: string[] = [];
    try {
      files = await fs.promises.readdir(this.windowsDir);
    } catch {
      return [];
    }
    const result: WindowEntry[] = [];
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const entry = await readJson<WindowEntry>(path.join(this.windowsDir, file));
      if (entry && entry.id !== this.id && alive(entry.pid)) {
        result.push(entry);
      }
    }
    return result;
  }

  private async cleanStale() {
    try {
      for (const file of await fs.promises.readdir(this.windowsDir)) {
        const full = path.join(this.windowsDir, file);
        const entry = await readJson<WindowEntry>(full);
        if (!entry || !alive(entry.pid)) {
          await fs.promises.rm(full, { force: true });
          if (entry) {
            await fs.promises.rm(path.join(this.root, "inbox", entry.id), { recursive: true, force: true });
          }
        }
      }
      for (const file of await fs.promises.readdir(this.repliesDir)) {
        const full = path.join(this.repliesDir, file);
        const stat = await fs.promises.stat(full);
        if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) {
          await fs.promises.rm(full, { force: true });
        }
      }
    } catch {
      // ignore
    }
  }

  /** Windows open on folders inside `paths`, from the registrations and VS Code's `storage.json`. */
  async otherWindows(paths: readonly string[]): Promise<OtherWindow[]> {
    const inside = (folder: string) => paths.some((p) => isInside(folder, p));
    const result: OtherWindow[] = [];
    const managedFolders = new Set<string>();
    for (const entry of await this.entries()) {
      entry.folders.forEach((f) => managedFolders.add(pathKey(f)));
      const affected = entry.folders.filter(inside);
      if (affected.length > 0) {
        result.push({ folders: affected, managed: true, willClose: affected.length === entry.folders.length });
      }
    }
    const own = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => pathKey(f.uri.fsPath)));
    for (const folder of this.storageJsonFolders()) {
      const key = pathKey(folder);
      if (inside(folder) && !managedFolders.has(key) && !own.has(key)) {
        result.push({ folders: [folder], managed: false, willClose: false });
      }
    }
    return result;
  }

  /** Folders of open windows as last saved by VS Code (updated when a window loses focus). */
  private storageJsonFolders(): string[] {
    if (!this.userDataGlobalStorage) {
      return [];
    }
    try {
      const storage = JSON.parse(fs.readFileSync(path.join(this.userDataGlobalStorage, "storage.json"), "utf8"));
      const state = storage?.windowsState ?? {};
      const windows = [...(Array.isArray(state.openedWindows) ? state.openedWindows : []), state.lastActiveWindow];
      return windows
        .map((w: { folder?: string } | undefined) => (typeof w?.folder === "string" ? uriToPath(w.folder) : undefined))
        .filter((p: string | undefined): p is string => !!p);
    } catch {
      return [];
    }
  }

  /**
   * Asks every other window to let go of `paths`: windows whose folders are all inside close,
   * others remove the affected folders; all close terminals working inside. Waits for closing
   * windows to exit.
   */
  async releaseInOtherWindows(paths: readonly string[], closeTerminals: boolean): Promise<ReleaseReply[]> {
    const entries = await this.entries();
    const replies = await Promise.all(entries.map((entry) => this.request(entry, paths, closeTerminals)));
    const closing = entries.filter((_, i) => replies[i]?.action === "closing");
    const deadline = Date.now() + 10_000;
    while (closing.some((e) => alive(e.pid)) && Date.now() < deadline) {
      await sleep(200);
    }
    for (const entry of closing.filter((e) => alive(e.pid))) {
      this.log.warn(`The VS Code window (extension host PID ${entry.pid}) did not close within 10 seconds.`);
    }
    return replies.filter((r): r is ReleaseReply => !!r);
  }

  private async request(entry: WindowEntry, paths: readonly string[], closeTerminals: boolean): Promise<ReleaseReply | undefined> {
    const request: ReleaseRequest = { id: crypto.randomBytes(8).toString("hex"), from: this.id, paths: [...paths], closeTerminals };
    const inbox = path.join(this.root, "inbox", entry.id);
    try {
      await fs.promises.mkdir(inbox, { recursive: true });
      await writeJsonAtomic(path.join(inbox, `${request.id}.req.json`), request);
    } catch (e) {
      this.log.warn(`Could not send a request to window ${entry.id}: ${(e as Error).message}`);
      return undefined;
    }
    const replyFile = path.join(this.repliesDir, `${request.id}.json`);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const reply = await readJson<ReleaseReply>(replyFile);
      if (reply) {
        await fs.promises.rm(replyFile, { force: true });
        if (reply.action !== "none") {
          this.log.info(`Window ${entry.id} (${entry.folders.join(", ") || "no folder"}): ${reply.action}, closed ${reply.closedTerminals} terminal(s)`);
        }
        return reply;
      }
      if (!alive(entry.pid)) {
        return undefined;
      }
      await sleep(100);
    }
    this.log.warn(`The window ${entry.id} (${entry.folders.join(", ")}) did not answer.`);
    await fs.promises.rm(path.join(inbox, `${request.id}.req.json`), { force: true });
    return undefined;
  }

  private async processInbox() {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.inbox);
    } catch {
      return;
    }
    for (const file of files.filter((f) => f.endsWith(".req.json"))) {
      if (this.handling.has(file)) {
        continue;
      }
      this.handling.add(file);
      const full = path.join(this.inbox, file);
      const request = await readJson<ReleaseRequest>(full);
      await fs.promises.rm(full, { force: true });
      if (request) {
        await this.handle(request);
      }
      this.handling.delete(file);
    }
  }

  private async handle(request: ReleaseRequest) {
    const reply: ReleaseReply = { window: this.id, action: "none", closedTerminals: 0 };
    let after: (() => Thenable<unknown>) | undefined;
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const affected = folders.filter((f) => f.uri.scheme === "file" && request.paths.some((p) => isInside(f.uri.fsPath, p)));
      const released = await releaseInThisWindow(request.paths, { closeTerminals: request.closeTerminals, removeFolders: false });
      reply.closedTerminals = released.closedTerminals;
      if (released.closedTerminals > 0 || released.closedRepositories > 0) {
        reply.action = "released";
      }
      if (affected.length > 0 && affected.length === folders.length) {
        await revertDocumentsInside(request.paths);
        // The window closes anyway; ending tasks and terminals first avoids "terminate running task?" prompts.
        for (const execution of vscode.tasks.taskExecutions) {
          execution.terminate();
        }
        for (const terminal of vscode.window.terminals) {
          terminal.dispose();
          reply.closedTerminals++;
        }
        reply.action = "closing";
        after = () => vscode.commands.executeCommand("workbench.action.closeWindow");
      } else if (affected.length > 0) {
        reply.action = "removed";
        after = () => removeWorkspaceFolders(affected);
      }
    } catch (e) {
      reply.error = (e as Error).message;
    }
    await writeJsonAtomic(path.join(this.repliesDir, `${request.id}.json`), reply).catch(() => undefined);
    if (after) {
      this.log.info(`Another window is removing worktree(s) ${request.paths.join(", ")}: ${reply.action === "closing" ? "closing this window" : "removing them from this window"}.`);
      await after();
    }
  }
}

/** Discards unsaved changes of documents inside the paths (they are being deleted anyway). */
async function revertDocumentsInside(paths: readonly string[]) {
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.scheme === "file" && paths.some((p) => isInside(doc.uri.fsPath, p))) {
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
  }
}

/** Removes workspace folders one at a time, waiting for each change to apply. */
export async function removeWorkspaceFolders(folders: readonly vscode.WorkspaceFolder[]) {
  for (const folder of [...folders].sort((a, b) => b.index - a.index)) {
    const current = vscode.workspace.workspaceFolders?.find((f) => f.uri.toString() === folder.uri.toString());
    if (!current) {
      continue;
    }
    const changed = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        sub.dispose();
        resolve();
      });
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, 5000);
    });
    if (vscode.workspace.updateWorkspaceFolders(current.index, 1)) {
      await changed;
    }
  }
}

/**
 * Lets go of `paths` in this window: closes terminals working inside, closes git repositories
 * inside (their watchers), and optionally removes workspace folders inside.
 */
export async function releaseInThisWindow(
  paths: readonly string[],
  options: { closeTerminals: boolean; removeFolders: boolean },
): Promise<{ closedTerminals: number; closedRepositories: number; removedFolders: number }> {
  const inside = (p: string | undefined) => !!p && paths.some((root) => isInside(p, root));
  let closedTerminals = 0;
  if (options.closeTerminals) {
    for (const terminal of vscode.window.terminals) {
      if (inside(terminalCwd(terminal))) {
        terminal.dispose();
        closedTerminals++;
      }
    }
  }
  let closedRepositories = 0;
  const gitApi = await getGitApi();
  for (const repository of gitApi?.repositories ?? []) {
    if (inside(repository.rootUri.fsPath)) {
      try {
        await vscode.commands.executeCommand("git.close", repository.rootUri);
        closedRepositories++;
      } catch {
        // best effort
      }
    }
  }
  let removedFolders = 0;
  if (options.removeFolders) {
    const affected = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file" && inside(f.uri.fsPath));
    await removeWorkspaceFolders(affected);
    removedFolders = affected.length;
  }
  if (closedTerminals > 0) {
    // Give the shells a moment to exit and release the folder.
    await sleep(300);
  }
  return { closedTerminals, closedRepositories, removedFolders };
}

// Minimal subset of the built-in git extension's API (extensions/git/src/api/git.d.ts).
export interface GitRepositoryApi {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly HEAD?: { readonly name?: string }; readonly onDidChange: vscode.Event<void> };
}

export interface GitApi {
  readonly git: { readonly path: string };
  readonly repositories: GitRepositoryApi[];
  readonly onDidOpenRepository: vscode.Event<GitRepositoryApi>;
  readonly onDidCloseRepository: vscode.Event<GitRepositoryApi>;
}

let gitApiPromise: Promise<GitApi | undefined> | undefined;

export function getGitApi(): Promise<GitApi | undefined> {
  gitApiPromise ??= (async () => {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi; enabled: boolean }>("vscode.git");
    if (!extension) {
      return undefined;
    }
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      return exports.enabled ? exports.getAPI(1) : undefined;
    } catch {
      return undefined;
    }
  })();
  return gitApiPromise;
}

import * as assert from "assert";
import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ReapSummary } from "../../reaper";
import { git, write } from "../fixture";

const root = process.env.BRANCH_REAPER_TEST_ROOT!;
const repo = process.env.BRANCH_REAPER_TEST_REPO!;
const codePath = process.env.BRANCH_REAPER_CODE_PATH!;
const worktreesDir = path.join(root, "repo.worktrees");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what: string, condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(250);
  }
}

function branchExists(name: string): boolean {
  return git(repo, "branch", "--list", name) !== "";
}

function remoteBranchExists(name: string): boolean {
  return git(repo, "ls-remote", "--heads", "origin", name) !== "";
}

function registeredFolders(): string[] {
  const user = process.platform === "win32" ? os.userInfo().username : String(os.userInfo().uid);
  const dir = path.join(os.tmpdir(), `branch-reaper-${user.replace(/[^\w.-]/g, "_")}`, "windows");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).flatMap((file) => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).folders as string[]).map((f) => f.toLowerCase());
    } catch {
      return [];
    }
  });
}

async function deleteBranch(branch: string): Promise<ReapSummary> {
  const summary = await vscode.commands.executeCommand<ReapSummary | undefined>("branchReaper.deleteBranch", { repository: repo, branch });
  assert.ok(summary, "the command returned no summary");
  return summary;
}

function alive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

suite("Branch Reaper: delete branch", () => {
  const config = () => vscode.workspace.getConfiguration("branchReaper");

  suiteSetup(async () => {
    await vscode.extensions.getExtension("luiscantero.branch-reaper")!.activate();
    await config().update("confirm", false, vscode.ConfigurationTarget.Global);
    await config().update("deleteRemote", "always", vscode.ConfigurationTarget.Global);
  });

  test("deletes a branch with two worktrees, one of them locked and dirty", async () => {
    const wt1 = path.join(worktreesDir, "wt1");
    const wt2 = path.join(worktreesDir, "wt2");
    git(repo, "worktree", "add", "-q", "-b", "feature/locked", wt1);
    git(wt1, "push", "-q", "-u", "origin", "feature/locked");
    git(repo, "worktree", "add", "-q", "--force", wt2, "feature/locked");
    git(repo, "worktree", "lock", "--reason", "agent session running", wt2);
    // Dirty: a modified tracked file, untracked files and an ignored folder.
    write(path.join(wt2, "README.md"), "modified\n");
    write(path.join(wt2, "notes", "todo.txt"), "untracked\n");
    write(path.join(wt2, ".gitignore"), "node_modules/\n");
    write(path.join(wt2, "node_modules", "pkg", "index.js"), "ignored\n");
    fs.chmodSync(path.join(wt2, "node_modules", "pkg", "index.js"), 0o444);
    assert.ok(git(wt2, "status", "--porcelain").length > 0);
    assert.match(git(repo, "worktree", "list", "--porcelain"), /locked agent session running/);

    // Briefly hold a file open in the locked worktree: the folder deletion has to retry.
    const held = fs.openSync(path.join(wt2, "notes", "todo.txt"), "r");
    setTimeout(() => fs.closeSync(held), 1500);

    const summary = await deleteBranch("feature/locked");

    assert.strictEqual(summary.results.length, 1);
    const [result] = summary.results;
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.branchDeleted, true);
    assert.strictEqual(result.worktreesRemoved, 2);
    assert.strictEqual(result.lockedWorktreesRemoved, 1);
    assert.strictEqual(result.remoteDeleted, "origin/feature/locked");
    assert.match(summary.message, /Deleted 1 branch, 2 worktrees \(1 was locked\)/);
    assert.ok(!fs.existsSync(wt1), "wt1 folder still exists");
    assert.ok(!fs.existsSync(wt2), "wt2 folder still exists");
    assert.ok(!branchExists("feature/locked"), "the branch still exists");
    assert.ok(!remoteBranchExists("feature/locked"), "the remote branch still exists");
    const listed = git(repo, "worktree", "list", "--porcelain");
    assert.doesNotMatch(listed, /wt1|wt2/);
  });

  test("deletes several branches with their worktrees after one confirmation", async () => {
    const names = ["multi/a", "multi/b", "multi/c"];
    git(repo, "worktree", "add", "-q", "-b", names[0], path.join(worktreesDir, "multi-a"));
    git(repo, "worktree", "add", "-q", "-b", names[1], path.join(worktreesDir, "multi-b"));
    git(repo, "worktree", "lock", path.join(worktreesDir, "multi-b"));
    git(repo, "branch", names[2]);

    const summary = await vscode.commands.executeCommand<ReapSummary | undefined>("branchReaper.deleteBranch", { repository: repo, branches: names });

    assert.ok(summary);
    assert.strictEqual(summary.results.length, 3);
    assert.match(summary.message, /Deleted 3 branches, 2 worktrees \(1 was locked\)/);
    for (const name of names) {
      assert.ok(!branchExists(name), `${name} still exists`);
    }
    assert.ok(!fs.existsSync(path.join(worktreesDir, "multi-a")));
    assert.ok(!fs.existsSync(path.join(worktreesDir, "multi-b")));
  });

  test("refuses protected branches and the main worktree's branch", async () => {
    git(repo, "branch", "release-1");
    const summary = await vscode.commands.executeCommand<ReapSummary | undefined>("branchReaper.deleteBranch", { repository: repo, branch: "release-1" });
    assert.strictEqual(summary, undefined);
    assert.ok(branchExists("release-1"));
    assert.ok(branchExists("main"));
  });

  test("closes another VS Code window open on the worktree, with a task running in it", async function () {
    const wt = path.join(worktreesDir, "open-elsewhere");
    git(repo, "worktree", "add", "-q", "-b", "open-elsewhere", wt);
    git(repo, "worktree", "lock", wt);
    write(path.join(wt, "dirty.txt"), "uncommitted\n");
    // A task that starts with the folder and keeps running in it, like an agent in a terminal.
    write(
      path.join(wt, ".vscode", "tasks.json"),
      JSON.stringify({
        version: "2.0.0",
        tasks: [
          {
            label: "hold",
            type: "process",
            command: process.platform === "win32" ? "cmd.exe" : "sh",
            args: process.platform === "win32" ? ["/c", "echo started> started.txt && ping -n 600 127.0.0.1 > nul"] : ["-c", "echo started > started.txt; sleep 600"],
            options: { cwd: "${workspaceFolder}" },
            runOptions: { runOn: "folderOpen" },
          },
        ],
      }),
    );

    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "br-second-"));
    write(
      path.join(userData, "data", "User", "settings.json"),
      JSON.stringify({ "task.allowAutomaticTasks": "on", "window.restoreWindows": "none", "git.openRepositoryInParentFolders": "never" }),
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("VSCODE_")) {
        delete env[key];
      }
    }
    const extensionPath = vscode.extensions.getExtension("luiscantero.branch-reaper")!.extensionPath;
    let second: ChildProcess | undefined;
    try {
      second = spawn(
        codePath,
        [
          wt,
          `--extensionDevelopmentPath=${extensionPath}`,
          `--user-data-dir=${path.join(userData, "data")}`,
          `--extensions-dir=${path.join(userData, "extensions")}`,
          "--disable-workspace-trust",
          "--skip-welcome",
          "--skip-release-notes",
          "--disable-updates",
          "--no-sandbox",
          "--disable-gpu-sandbox",
          "--new-window",
        ],
        { env, stdio: "ignore", detached: process.platform !== "win32" },
      );
      await waitFor("the second window to register", () => registeredFolders().includes(wt.toLowerCase()), 90_000);
      await waitFor("the task in the second window to start", () => fs.existsSync(path.join(wt, "started.txt")), 60_000);
      await sleep(1000);

      const summary = await deleteBranch("open-elsewhere");

      const [result] = summary.results;
      assert.deepStrictEqual(result.errors, []);
      assert.deepStrictEqual(result.leftovers, []);
      assert.strictEqual(result.branchDeleted, true);
      assert.strictEqual(result.worktreesRemoved, 1);
      assert.ok(!fs.existsSync(wt), "the worktree folder still exists");
      assert.ok(!branchExists("open-elsewhere"));
      await waitFor("the second window to close", () => !registeredFolders().includes(wt.toLowerCase()), 15_000);
    } finally {
      if (second && alive(second.pid)) {
        try {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(second.pid), "/t", "/f"], { stdio: "ignore" });
          } else {
            process.kill(-second.pid!, "SIGKILL");
          }
        } catch {
          // already gone
        }
      }
      await sleep(1000);
      fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  });

  test("still deletes the branch when a process keeps the folder in use, and names the process", async function () {
    await config().update("worktreeDeleteRetryMs", 1000, vscode.ConfigurationTarget.Global);
    const wt = path.join(worktreesDir, "held");
    git(repo, "worktree", "add", "-q", "-b", "held", wt);
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
      cwd: wt,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    try {
      await sleep(500);
      const summary = await deleteBranch("held");
      const [result] = summary.results;
      assert.strictEqual(result.branchDeleted, true);
      assert.ok(!branchExists("held"));
      assert.doesNotMatch(git(repo, "worktree", "list", "--porcelain"), /held/);
      if (process.platform === "win32") {
        // Windows cannot delete a folder that is a process's working directory.
        assert.strictEqual(result.leftovers.length, 1);
        assert.ok(
          result.leftovers[0].lockers.some((l) => l.pid === holder.pid),
          `expected PID ${holder.pid} in ${JSON.stringify(result.leftovers[0].lockers)}`,
        );
        assert.match(summary.message, new RegExp(`could not be deleted, in use by .*PID ${holder.pid}`));
      } else {
        assert.deepStrictEqual(result.leftovers, []);
        assert.ok(!fs.existsSync(wt));
      }
    } finally {
      holder.kill();
      await config().update("worktreeDeleteRetryMs", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});

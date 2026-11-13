// Takes the README screenshots: builds a demo repository with agent-style branches and worktrees,
// starts VS Code with the extension through Playwright and captures the view, the branch picker
// and the confirmation. Run `npm run compile` first, then `npm run screenshots`.
// DEMO_ROOT sets where the demo repository is created (default C:\src or /tmp/src); it is shown
// in the screenshots and removed afterwards.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { _electron as electron } from "playwright-core";

const extensionRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.join(extensionRoot, "images");
const demoRoot = process.env.DEMO_ROOT ?? (process.platform === "win32" ? "C:\\src" : "/tmp/src");
const createdRoot = !fs.existsSync(demoRoot);
const repo = path.join(demoRoot, "contoso-app");
const origin = path.join(demoRoot, "contoso-app-origin.git");
const worktrees = path.join(demoRoot, "contoso-app.worktrees");
if (fs.existsSync(repo) || fs.existsSync(origin) || fs.existsSync(worktrees)) {
  throw new Error(`${repo} already exists; remove it or set DEMO_ROOT.`);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "br-shots-"));

let clock = Date.now() / 1000;
const ago = (days) => Math.round(Date.now() / 1000 - days * 86400);
function git(cwd, ...args) {
  const date = `${Math.round(clock)} +0100`;
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Luis Cantero",
      GIT_AUTHOR_EMAIL: "luis@example.com",
      GIT_COMMITTER_NAME: "Luis Cantero",
      GIT_COMMITTER_EMAIL: "luis@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}
function commit(cwd, file, text, message, days) {
  clock = ago(days);
  const full = path.join(cwd, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  git(cwd, "add", "--", file);
  git(cwd, "commit", "-q", "-m", message);
}
/** A branch with its own worktree, as an agent session creates it. */
function agentBranch(name, folder, days, files) {
  const dir = path.join(worktrees, folder);
  git(repo, "worktree", "add", "-q", "-b", name, dir, "main");
  for (const [file, text, message] of files) {
    commit(dir, file, text, message, days);
  }
  return dir;
}
function squashIntoMain(branch, message, days) {
  clock = ago(days);
  git(repo, "merge", "-q", "--squash", branch);
  git(repo, "commit", "-q", "-m", message);
}

function createDemo() {
  fs.mkdirSync(demoRoot, { recursive: true });
  clock = ago(30);
  git(demoRoot, "init", "-q", "--bare", "-b", "main", origin);
  git(demoRoot, "init", "-q", "-b", "main", repo);
  git(repo, "config", "core.autocrlf", "false");
  commit(repo, "README.md", "# Contoso App\n", "Initial commit", 30);
  commit(repo, "src/config.ts", "export const timeoutMs = 5000;\n", "Add configuration", 28);
  commit(repo, "src/cache.ts", "export const cache = new Map();\n", "Add cache", 27);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");

  // Squash-merged pull requests whose remote branch was deleted.
  agentBranch("users/luis/fix-login-timeout", "fix-login-timeout", 11, [["src/login.ts", "export const loginTimeoutMs = 30000;\n", "Fix login timeout"]]);
  git(repo, "push", "-q", "-u", "origin", "users/luis/fix-login-timeout");
  squashIntoMain("users/luis/fix-login-timeout", "Fix login timeout (#41)", 10);
  git(repo, "push", "-q", "origin", "--delete", "users/luis/fix-login-timeout");

  const retry = agentBranch("users/luis/add-retry-policy", "add-retry-policy", 7, [
    ["src/retry.ts", "export const retries = 3;\n", "Add retry policy"],
    ["src/retry.test.ts", "// tests\n", "Test retry policy"],
  ]);
  git(repo, "push", "-q", "-u", "origin", "users/luis/add-retry-policy");
  squashIntoMain("users/luis/add-retry-policy", "Add retry policy (#42)", 6);
  git(repo, "push", "-q", "origin", "--delete", "users/luis/add-retry-policy");
  git(repo, "worktree", "lock", "--reason", "Copilot agent session", retry);

  agentBranch("users/luis/update-docs", "update-docs", 3, [["docs/setup.md", "# Setup\n", "Document setup"]]);
  squashIntoMain("users/luis/update-docs", "Document setup (#44)", 2);

  // Upstream gone, but its changes are not in main.
  agentBranch("users/luis/spike-cache-layer", "spike-cache-layer", 14, [["src/cache.ts", "export const cache = new WeakMap();\n", "Try a weak cache"]]);
  git(repo, "push", "-q", "-u", "origin", "users/luis/spike-cache-layer");
  git(repo, "push", "-q", "origin", "--delete", "users/luis/spike-cache-layer");
  commit(repo, "src/cache.ts", "export const cache = new Map<string, unknown>();\n", "Type the cache", 9);

  // Work in progress.
  const dashboard = agentBranch("users/luis/telemetry-dashboard", "telemetry-dashboard", 1, [["src/dashboard.ts", "export {};\n", "Start telemetry dashboard"]]);
  git(repo, "push", "-q", "-u", "origin", "users/luis/telemetry-dashboard");
  fs.writeFileSync(path.join(dashboard, "src", "dashboard.ts"), "export const charts = [];\n");
  clock = ago(0.2);
  git(repo, "branch", "users/luis/refactor-config", "main");
  git(repo, "branch", "release-2026.11", "main");
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "--prune");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  createDemo();
  const executablePath = await downloadAndUnzipVSCode(process.env.BRANCH_REAPER_TEST_VSCODE ?? "stable");
  const userData = path.join(profile, "data");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({
      "window.dialogStyle": "custom",
      "window.restoreWindows": "none",
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
      "workbench.layoutControl.enabled": false,
      "chat.disableAIFeatures": true,
      "window.commandCenter": false,
      "git.openRepositoryInParentFolders": "never",
      "scm.repositories.visible": 0,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.ignoreRecommendations": true,
      "workbench.colorTheme": "Default Dark Modern",
    }),
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("VSCODE_")) {
      delete env[key];
    }
  }
  const app = await electron.launch({
    executablePath,
    env,
    args: [
      repo,
      path.join(repo, "src", "cache.ts"),
      `--extensionDevelopmentPath=${extensionRoot}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(profile, "extensions")}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-updates",
      "--force-device-scale-factor=1",
    ],
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.unmaximize();
      win.setContentSize(1280, 760);
      win.center();
    });
    await sleep(4000);

    const runCommand = async (title) => {
      await page.keyboard.press("F1");
      await page.waitForSelector(".quick-input-widget:not([style*='display: none'])");
      await page.keyboard.type(title);
      await sleep(600);
      await page.keyboard.press("Enter");
      await sleep(800);
    };
    const shot = async (name, clip, keepMouse = false) => {
      if (!keepMouse) {
        await page.mouse.move(1270, 750);
      }
      await sleep(800);
      await page.screenshot({ path: path.join(imagesDir, name), clip });
      console.log(`wrote images/${name}`);
    };

    fs.mkdirSync(imagesDir, { recursive: true });
    await runCommand("Notifications: Clear All Notifications");
    await runCommand("View: Focus on Branches & Worktrees View");
    // Collapse the other Source Control views so the Branches & Worktrees view gets the space.
    for (const title of ["Changes", "Graph"]) {
      const header = page.locator(".pane-header[aria-expanded='true']").filter({ hasText: new RegExp(`^${title}`) });
      if (await header.count()) {
        await header.first().locator("h3.title").click();
        await sleep(300);
      }
    }
    // Widen the side bar.
    const sash = await page.locator(".part.sidebar").boundingBox();
    if (sash) {
      await page.mouse.move(sash.x + sash.width + 1, 300);
      await page.mouse.down();
      await page.mouse.move(560, 300, { steps: 10 });
      await page.mouse.up();
      await sleep(500);
    }
    await page.waitForSelector('.monaco-list-row[aria-label*="fix-login-timeout"]', { timeout: 30_000 });
    // Show the worktrees of two branches.
    for (const branch of ["add-retry-policy", "spike-cache-layer"]) {
      await page.locator(".monaco-list-row").filter({ hasText: new RegExp(`^${branch}`) }).first().locator(".monaco-tl-twistie").click();
      await sleep(300);
    }
    await runCommand("Branch Reaper: Check All Merged Branches");
    if (await page.locator(".part.panel").isVisible()) {
      await page.keyboard.press("Control+J");
      await sleep(500);
    }
    await shot("tree-view.png");

    // The tooltip shows the full branch name, upstream and worktrees; hovers do not always trigger.
    const label = page.locator(".monaco-list-row").filter({ hasText: /^add-retry-policy/ }).first().locator(".label-name").first();
    for (let attempt = 1; ; attempt++) {
      await page.mouse.move(700, 600);
      await sleep(300);
      await label.hover();
      try {
        await page.getByText("users/luis/add-retry-policy", { exact: true }).first().waitFor({ timeout: 5000 });
        break;
      } catch (e) {
        if (attempt === 4) {
          throw e;
        }
      }
    }
    await sleep(500);
    await shot("tooltip.png", { x: 0, y: 0, width: 760, height: 420 }, true);
    await page.mouse.move(1270, 750);
    await sleep(500);

    await page.keyboard.press("Control+Alt+Shift+D");
    await page.waitForSelector('.quick-input-list .monaco-list-row[aria-label*="telemetry-dashboard"]', { timeout: 30_000 });
    await sleep(1500);
    for (const branch of ["fix-login-timeout", "update-docs"]) {
      await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: branch }).first().click({ position: { x: 16, y: 12 } });
      await sleep(200);
    }
    await shot("quick-pick.png");
    await page.keyboard.press("Escape");
    await sleep(500);

    await runCommand("Branch Reaper: Delete Checked Branches");
    await page.waitForSelector(".monaco-dialog-box", { timeout: 30_000 });
    await shot("confirmation.png");
    await page.locator(".monaco-dialog-box .monaco-button", { hasText: /^Delete$/ }).click();
    await page.waitForSelector('.notification-toast:has-text("Deleted")', { timeout: 60_000 });
    await shot("summary.png");
  } catch (e) {
    const page = app.windows()[0];
    await page?.screenshot({ path: path.join(os.tmpdir(), "br-shots-debug.png") }).catch(() => undefined);
    console.error(`Debug screenshot: ${path.join(os.tmpdir(), "br-shots-debug.png")}`);
    throw e;
  } finally {
    await app.close().catch(() => undefined);
  }
}

try {
  await main();
} finally {
  await sleep(1000);
  for (const dir of [repo, origin, worktrees, profile]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
  if (createdRoot) {
    fs.rmSync(demoRoot, { recursive: true, force: true });
  }
}

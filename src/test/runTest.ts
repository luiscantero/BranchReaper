import * as fs from "fs";
import * as path from "path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { createRepoWithOrigin, tempDir, write } from "./fixture";

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");
  // BRANCH_REAPER_TEST_VSCODE: a version such as "insiders" or "1.100.0", or the path of a VS Code executable.
  const requested = process.env.BRANCH_REAPER_TEST_VSCODE ?? "stable";
  const vscodeExecutablePath = fs.existsSync(requested) ? requested : await downloadAndUnzipVSCode(requested);

  const root = tempDir("br-it-");
  const { repo } = createRepoWithOrigin(root);
  const userDataDir = path.join(root, "user-data");
  write(path.join(userDataDir, "User", "settings.json"), JSON.stringify({ "git.openRepositoryInParentFolders": "never", "window.restoreWindows": "none" }));
  let exitCode = 0;
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [repo, "--disable-extensions", "--disable-workspace-trust", `--user-data-dir=${userDataDir}`],
      extensionTestsEnv: {
        BRANCH_REAPER_TEST_ROOT: root,
        BRANCH_REAPER_TEST_REPO: repo,
        BRANCH_REAPER_CODE_PATH: vscodeExecutablePath,
      },
    });
  } catch (e) {
    console.error(`Integration tests failed: ${(e as Error).message}`);
    exitCode = 1;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (e) {
      console.warn(`Could not remove ${root}: ${(e as Error).message}`);
    }
  }
  process.exit(exitCode);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

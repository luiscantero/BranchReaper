import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Runs git synchronously with a fixed identity, returning trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function tempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function commit(repo: string, file: string, text: string, message: string) {
  write(path.join(repo, file), text);
  git(repo, "add", "--", file);
  git(repo, "commit", "-q", "-m", message);
}

/** A repository `repo` with a bare `origin`, `main` pushed and `origin/HEAD` set. */
export function createRepoWithOrigin(root: string): { repo: string; origin: string } {
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", repo);
  git(repo, "config", "core.autocrlf", "false");
  commit(repo, "README.md", "hello\n", "initial");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  return { repo, origin };
}

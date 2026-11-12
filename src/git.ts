import { execFile } from "child_process";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Log only the command and exit code, not the output (for large read-only queries). */
  quiet?: boolean;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(" ")} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

const MAX_LOGGED = 4000;

/** Runs git without a shell, so arguments such as branch names are never interpreted. */
export class Git {
  constructor(
    readonly path: string,
    private readonly log: Logger,
  ) {}

  run(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<GitResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      execFile(
        this.path,
        args as string[],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 256 * 1024 * 1024,
          windowsHide: true,
          timeout: options.timeoutMs ?? 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
          let code = 0;
          if (err) {
            code = typeof err.code === "number" ? err.code : -1;
            if (err.killed) {
              stderr = `${stderr}\n(timed out after ${options.timeoutMs ?? 60_000} ms)`;
            } else if (typeof err.code === "string") {
              stderr = `${stderr}\n${err.message}`;
            }
          }
          const result: GitResult = { code, stdout: stdout ?? "", stderr: stderr ?? "" };
          this.logResult(cwd, args, result, Date.now() - started, options.quiet);
          resolve(result);
        },
      );
    });
  }

  /** Like `run`, but throws a GitError on a non-zero exit code. */
  async exec(cwd: string, args: readonly string[], options?: RunOptions): Promise<string> {
    const result = await this.run(cwd, args, options);
    if (result.code !== 0) {
      throw new GitError(args, result);
    }
    return result.stdout;
  }

  private logResult(cwd: string, args: readonly string[], result: GitResult, ms: number, quiet?: boolean) {
    const command = `$ git ${args.map(quoteForLog).join(" ")}    (in ${cwd})`;
    const lines = [command, `  exit ${result.code}, ${ms} ms`];
    if (!quiet || result.code !== 0) {
      for (const [label, text] of [
        ["stdout", result.stdout],
        ["stderr", result.stderr],
      ] as const) {
        const trimmed = text.replace(/\0/g, "␀").trim();
        if (trimmed) {
          const shown = trimmed.length > MAX_LOGGED ? `${trimmed.slice(0, MAX_LOGGED)}\n… (${trimmed.length - MAX_LOGGED} more characters)` : trimmed;
          lines.push(`  ${label}: ${shown.replace(/\n/g, "\n    ")}`);
        }
      }
    }
    (result.code === 0 ? this.log.info : this.log.warn).call(this.log, lines.join("\n"));
  }
}

function quoteForLog(arg: string): string {
  return /^[\w@%+=:,./\\^~-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

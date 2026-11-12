import * as assert from "assert";
import { branchName, parseWorktreeList } from "../../porcelain";

suite("parseWorktreeList", () => {
  test("parses -z output with main, locked, prunable and detached worktrees", () => {
    const output = [
      "worktree C:/repos/app",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree C:/repos/app.worktrees/feature",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature/x",
      "locked agent session\nstill running",
      "",
      "worktree C:/repos/app.worktrees/gone",
      "HEAD 3333333333333333333333333333333333333333",
      "branch refs/heads/old",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree C:/repos/app.worktrees/detached",
      "HEAD 4444444444444444444444444444444444444444",
      "detached",
      "locked",
      "",
    ].join("\0");
    const worktrees = parseWorktreeList(output);
    assert.strictEqual(worktrees.length, 4);
    assert.deepStrictEqual(worktrees[0], {
      path: "C:/repos/app",
      head: "1111111111111111111111111111111111111111",
      branch: "refs/heads/main",
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      main: true,
    });
    assert.strictEqual(worktrees[1].main, false);
    assert.strictEqual(worktrees[1].locked, true);
    assert.strictEqual(worktrees[1].lockReason, "agent session\nstill running");
    assert.strictEqual(branchName(worktrees[1].branch), "feature/x");
    assert.strictEqual(worktrees[2].prunable, true);
    assert.strictEqual(worktrees[2].prunableReason, "gitdir file points to non-existent location");
    assert.strictEqual(worktrees[3].detached, true);
    assert.strictEqual(worktrees[3].branch, undefined);
    assert.strictEqual(worktrees[3].locked, true);
    assert.strictEqual(worktrees[3].lockReason, undefined);
  });

  test("keeps spaces and newlines in -z paths", () => {
    const worktrees = parseWorktreeList("worktree /tmp/my repo\0bare\0\0worktree /tmp/odd\nname\0HEAD abc\0branch refs/heads/b\0\0");
    assert.strictEqual(worktrees[0].path, "/tmp/my repo");
    assert.strictEqual(worktrees[0].bare, true);
    assert.strictEqual(worktrees[1].path, "/tmp/odd\nname");
    assert.strictEqual(worktrees[1].main, false);
  });

  test("parses newline output (git before 2.36) and unquotes paths", () => {
    const output = 'worktree /repo\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\nworktree "/repo.wt/caf\\303\\251 \\"x\\""\nHEAD def\ndetached\nlocked reason\n\n';
    const worktrees = parseWorktreeList(output, false);
    assert.strictEqual(worktrees.length, 2);
    assert.strictEqual(worktrees[0].branch, "refs/heads/main");
    assert.strictEqual(worktrees[1].path, '/repo.wt/café "x"');
    assert.strictEqual(worktrees[1].lockReason, "reason");
  });

  test("handles output without the trailing record terminator", () => {
    const worktrees = parseWorktreeList("worktree /a\0HEAD 1\0branch refs/heads/x");
    assert.strictEqual(worktrees.length, 1);
    assert.strictEqual(worktrees[0].branch, "refs/heads/x");
  });

  test("branchName ignores refs that are not local branches", () => {
    assert.strictEqual(branchName("refs/heads/a/b"), "a/b");
    assert.strictEqual(branchName("refs/remotes/origin/a"), undefined);
    assert.strictEqual(branchName(undefined), undefined);
  });
});

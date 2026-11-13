import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { BranchRef, isContentMerged, mergeStatus, parseBranches, parseMergedBranches, relativeAge, shortBranchLabels } from "../../branches";
import { Git, Logger } from "../../git";
import { shortPath } from "../../paths";
import { planDeletion, PlanInput } from "../../plan";
import { Worktree } from "../../porcelain";
import { protectedBy } from "../../protect";
import { loadSnapshot, resolveRepo } from "../../repo";
import { commit, createRepoWithOrigin, git, tempDir } from "../fixture";

const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

suite("merged detection", () => {
  test("parseBranches reads upstream, gone state and remote ref", () => {
    const line = (...fields: string[]) => fields.join("\0");
    const output = [
      line("refs/heads/feature/a", "aaa", "refs/remotes/origin/feature/a", "[gone]", "origin", "refs/heads/feature/a", "1700000000", "Add a"),
      line("refs/heads/b", "bbb", "refs/remotes/origin/b", "[ahead 1, behind 2]", "origin", "refs/heads/b", "1700000001", "B: with\0nul"),
      line("refs/heads/local", "ccc", "", "", "", "", "1700000002", "Local only"),
      "",
    ].join("\n");
    const branches = parseBranches(output);
    assert.deepStrictEqual(
      branches.map((b) => [b.name, b.upstreamGone, b.remote, b.remoteRef]),
      [
        ["feature/a", true, "origin", "refs/heads/feature/a"],
        ["b", false, "origin", "refs/heads/b"],
        ["local", false, undefined, undefined],
      ],
    );
    assert.strictEqual(branches[1].subject, "B: with\0nul");
    assert.strictEqual(branches[2].committerDate, 1700000002);
  });

  test("parseMergedBranches keeps local branches only", () => {
    assert.deepStrictEqual([...parseMergedBranches("refs/heads/main\r\nrefs/heads/a/b\nrefs/remotes/origin/x\n\n")], ["main", "a/b"]);
  });

  test("mergeStatus prefers ancestry, then content, then gone upstream", () => {
    const merged = new Set(["m"]);
    const content = new Set(["m", "s", "sg"]);
    assert.strictEqual(mergeStatus({ name: "m", upstreamGone: true }, merged, content), "merged");
    assert.strictEqual(mergeStatus({ name: "sg", upstreamGone: true }, merged, content), "squashMerged");
    assert.strictEqual(mergeStatus({ name: "g", upstreamGone: true }, merged, content), "gone");
    assert.strictEqual(mergeStatus({ name: "s", upstreamGone: false }, merged, content), "squashMerged");
    assert.strictEqual(mergeStatus({ name: "u", upstreamGone: false }, merged, content), "unmerged");
  });

  test("shortPath keeps the root and the folder name", () => {
    assert.strictEqual(shortPath("C:\\Users\\me\\Repos\\app.worktrees\\feature-x", path.win32), "C:\\…\\feature-x");
    assert.strictEqual(shortPath("C:\\Users\\me\\Repos\\app.worktrees\\feature-x\\", path.win32), "C:\\…\\feature-x");
    assert.strictEqual(shortPath("C:\\wt", path.win32), "C:\\wt");
    assert.strictEqual(shortPath("/home/me/repos/app.worktrees/feature-x", path.posix), "/…/feature-x");
  });

  test("shortBranchLabels keeps the last segment unless it is ambiguous", () => {
    const labels = shortBranchLabels(["users/luis/new-feature", "main", "users/luis/fix", "users/ana/fix", "fix", "a/b/c/x", "d/c/x", "x", "a/b/y", "b/y"]);
    assert.deepStrictEqual(Object.fromEntries(labels), {
      "users/luis/new-feature": "new-feature",
      main: "main",
      "users/luis/fix": "luis/fix",
      "users/ana/fix": "ana/fix",
      fix: "fix",
      "a/b/c/x": "b/c/x",
      "d/c/x": "d/c/x",
      x: "x",
      "a/b/y": "a/b/y",
      "b/y": "b/y",
    });
  });

  test("relativeAge picks the largest unit", () => {
    const now = 1_700_000_000_000;
    assert.strictEqual(relativeAge(now / 1000 - 30, now), "just now");
    assert.strictEqual(relativeAge(now / 1000 - 5 * 60, now), "5m ago");
    assert.strictEqual(relativeAge(now / 1000 - 3 * 86400 - 10, now), "3d ago");
    assert.strictEqual(relativeAge(now / 1000 - 15 * 86400, now), "2w ago");
  });

  test("isContentMerged needs a clean merge producing the base tree", () => {
    assert.strictEqual(isContentMerged(0, "abc\n", "abc"), true);
    assert.strictEqual(isContentMerged(0, "def\n", "abc"), false);
    assert.strictEqual(isContentMerged(1, "abc\nconflict info", "abc"), false);
    assert.strictEqual(isContentMerged(0, "", ""), false);
  });

  test("detects merged, squash-merged, gone and unmerged branches in a real repository", async function () {
    this.timeout(60_000);
    const root = tempDir("br-merged-");
    try {
      const { repo } = createRepoWithOrigin(root);
      // merged: fast-forwarded into main.
      git(repo, "checkout", "-q", "-b", "merged");
      commit(repo, "merged.txt", "m\n", "merged work");
      git(repo, "checkout", "-q", "main");
      git(repo, "merge", "-q", "--ff-only", "merged");
      // squashed: squash-merged into main, upstream kept, then main moved on.
      git(repo, "checkout", "-q", "-b", "squashed");
      commit(repo, "s1.txt", "1\n", "squash 1");
      commit(repo, "s2.txt", "2\n", "squash 2");
      git(repo, "checkout", "-q", "main");
      git(repo, "merge", "-q", "--squash", "squashed");
      git(repo, "commit", "-q", "-m", "Squashed (#1)");
      commit(repo, "later.txt", "later\n", "later work on main");
      git(repo, "push", "-q", "origin", "main");
      // gone: pushed with upstream, then deleted on the remote (as after a PR merge).
      git(repo, "checkout", "-q", "-b", "gone");
      commit(repo, "gone.txt", "g\n", "gone work");
      git(repo, "push", "-q", "-u", "origin", "gone");
      git(repo, "push", "-q", "origin", "--delete", "gone");
      git(repo, "fetch", "-q", "--prune");
      // unmerged: real work not in main.
      git(repo, "checkout", "-q", "main");
      git(repo, "checkout", "-q", "-b", "unmerged");
      commit(repo, "README.md", "changed\n", "unmerged work");
      git(repo, "checkout", "-q", "main");
      // into-preview: squash-merged into origin/preview (not main), upstream kept.
      git(repo, "checkout", "-q", "-b", "preview");
      commit(repo, "preview.txt", "p\n", "preview only");
      git(repo, "push", "-q", "-u", "origin", "preview");
      git(repo, "checkout", "-q", "-b", "into-preview");
      commit(repo, "feature.txt", "f\n", "preview feature");
      git(repo, "push", "-q", "-u", "origin", "into-preview");
      git(repo, "checkout", "-q", "preview");
      git(repo, "merge", "-q", "--squash", "into-preview");
      git(repo, "commit", "-q", "-m", "Preview feature (#2)");
      git(repo, "push", "-q", "origin", "preview");
      git(repo, "reset", "-q", "--hard", "HEAD~1");
      // into-release: merged into origin/release/1.0 with a merge commit.
      git(repo, "checkout", "-q", "main");
      git(repo, "checkout", "-q", "-b", "into-release");
      commit(repo, "fix.txt", "x\n", "release fix");
      git(repo, "push", "-q", "origin", "main:release/1.0");
      git(repo, "fetch", "-q");
      git(repo, "checkout", "-q", "--detach", "origin/release/1.0");
      git(repo, "merge", "-q", "--no-ff", "-m", "Merge fix", "into-release");
      git(repo, "push", "-q", "origin", "HEAD:release/1.0");
      git(repo, "checkout", "-q", "main");

      const gitRunner = new Git("git", quiet);
      const info = await resolveRepo(gitRunner, repo);
      assert.ok(info);
      const targetBranches = ["main", "preview", "release/**"];
      const withSquash = await loadSnapshot(gitRunner, info, { detectSquashMerged: true, targetBranches });
      assert.strictEqual(withSquash.base?.ref, "refs/remotes/origin/main");
      assert.deepStrictEqual(Object.fromEntries(withSquash.statuses), {
        gone: "gone",
        "into-preview": "squashMerged",
        "into-release": "merged",
        main: "merged",
        merged: "merged",
        // The local preview branch lags behind origin/preview; it is not "merged" into itself.
        preview: "unmerged",
        squashed: "squashMerged",
        unmerged: "unmerged",
      });
      assert.deepStrictEqual(Object.fromEntries(withSquash.mergedInto), { "into-preview": "preview", "into-release": "release/1.0" });
      const withoutSquash = await loadSnapshot(gitRunner, info, { detectSquashMerged: false, targetBranches });
      assert.strictEqual(withoutSquash.statuses.get("squashed"), "unmerged");
      assert.strictEqual(withoutSquash.statuses.get("into-preview"), "unmerged");
      const mainOnly = await loadSnapshot(gitRunner, info, { detectSquashMerged: true, targetBranches: [] });
      assert.strictEqual(mainOnly.statuses.get("into-release"), "unmerged");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves the main repository from inside a linked worktree", async function () {
    this.timeout(30_000);
    const root = tempDir("br-resolve-");
    try {
      const { repo } = createRepoWithOrigin(root);
      const wt = path.join(root, "repo.worktrees", "a");
      git(repo, "worktree", "add", "-q", "-b", "a", wt);
      const fromWorktree = await resolveRepo(new Git("git", quiet), path.join(wt));
      const fromMain = await resolveRepo(new Git("git", quiet), repo);
      assert.ok(fromWorktree && fromMain);
      assert.strictEqual(fromWorktree.key, fromMain.key);
      assert.strictEqual(fromWorktree.mainPath, path.normalize(repo));
      assert.strictEqual(fromWorktree.name, "repo");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite("protection and planning", () => {
  const patterns = ["main", "master", "release*", "releases/*"];

  test("protectedBy matches globs case-insensitively within path segments", () => {
    assert.strictEqual(protectedBy("main", patterns), "main");
    assert.strictEqual(protectedBy("Master", patterns), "master");
    assert.strictEqual(protectedBy("release-1.2", patterns), "release*");
    assert.strictEqual(protectedBy("releases/1.2", patterns), "releases/*");
    assert.strictEqual(protectedBy("releases/1.2/hotfix", patterns), undefined);
    assert.strictEqual(protectedBy("release/1.2", patterns), undefined);
    assert.strictEqual(protectedBy("users/me/main", patterns), undefined);
    assert.strictEqual(protectedBy("users/me/x", ["users/**"]), "users/**");
    assert.strictEqual(protectedBy("a.b", ["a?b"]), "a?b");
    assert.strictEqual(protectedBy("a+b", ["a+b"]), "a+b");
  });

  const root = process.platform === "win32" ? "C:\\r" : "/r";
  const p = (...parts: string[]) => path.join(root, ...parts);
  const wt = (dir: string, branch: string | undefined, extra: Partial<Worktree> = {}): Worktree => ({
    path: dir,
    branch: branch && `refs/heads/${branch}`,
    bare: false,
    detached: !branch,
    locked: false,
    prunable: false,
    main: false,
    ...extra,
  });
  const branch = (name: string, extra: Partial<BranchRef> = {}): BranchRef => ({ name, sha: "1", upstreamGone: false, committerDate: 0, subject: "", ...extra });
  const input = (name: string, extra: Partial<PlanInput> = {}): PlanInput => ({
    branch: branch(name),
    status: "merged",
    worktrees: [wt(p("app"), "main", { main: true }), wt(p("wt", "a"), "a", { locked: true }), wt(p("wt", "a2"), "a"), wt(p("wt", "d"), undefined)],
    protectedPatterns: patterns,
    defaultBranch: "develop",
    windowFolders: [{ path: p("app"), index: 0 }],
    remoteBranches: new Set(["origin/a", "origin/b"]),
    defaultRemote: "origin",
    ...extra,
  });

  test("plans all linked worktrees of the branch, including locked ones", () => {
    const result = planDeletion(input("a"));
    assert.ok("plan" in result);
    assert.deepStrictEqual(
      result.plan.worktrees.map((w) => [w.path, w.locked]),
      [
        [p("wt", "a"), true],
        [p("wt", "a2"), false],
      ],
    );
    assert.deepStrictEqual(result.plan.remote, { remote: "origin", ref: "refs/heads/a" });
    assert.deepStrictEqual(result.plan.windowFoldersToRemove, []);
  });

  test("refuses protected, default and main-worktree branches", () => {
    assert.deepStrictEqual(planDeletion(input("release-7")), { refused: "protected (release*)" });
    assert.deepStrictEqual(planDeletion(input("develop")), { refused: "the remote's default branch" });
    assert.deepStrictEqual(planDeletion(input("main", { protectedPatterns: [] })), { refused: "checked out in the main worktree" });
  });

  test("refuses the branch of this window's repository, removes other folders of the window", () => {
    assert.deepStrictEqual(planDeletion(input("a", { windowFolders: [{ path: p("wt", "a", "src"), index: 0 }] })), {
      refused: "checked out in this window's repository",
    });
    assert.deepStrictEqual(
      planDeletion(input("a", { windowFolders: [{ path: p("wt", "a"), index: 0 }, { path: p("app"), index: 1 }] })),
      { refused: "its worktree is this window's first workspace folder" },
    );
    const result = planDeletion(input("a", { windowFolders: [{ path: p("app"), index: 0 }, { path: p("wt", "a2"), index: 1 }] }));
    assert.ok("plan" in result);
    assert.deepStrictEqual(result.plan.windowFoldersToRemove, [{ path: p("wt", "a2"), index: 1 }]);
  });

  test("uses the upstream for the remote branch and skips gone upstreams", () => {
    const tracked = planDeletion(input("x", { branch: branch("x", { upstream: "refs/remotes/fork/y", remote: "fork", remoteRef: "refs/heads/y" }) }));
    assert.ok("plan" in tracked);
    assert.deepStrictEqual(tracked.plan.remote, { remote: "fork", ref: "refs/heads/y" });
    const gone = planDeletion(input("b", { branch: branch("b", { upstream: "refs/remotes/origin/b", upstreamGone: true, remote: "origin", remoteRef: "refs/heads/b" }) }));
    assert.ok("plan" in gone);
    assert.strictEqual(gone.plan.remote, undefined);
    const none = planDeletion(input("c"));
    assert.ok("plan" in none);
    assert.strictEqual(none.plan.remote, undefined);
  });
});

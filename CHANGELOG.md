# Changelog

## 0.2.1

- Unmerged and upstream-gone branches no longer have a checkbox in the Branches & Worktrees view; select them with Ctrl+click instead.

## 0.2.0

- Branches merged into other target branches, such as `preview` or `release/1.5`, count as merged (new setting `branchReaper.targetBranches`); the status names the target.

## 0.1.0

- Delete a branch with all of its worktrees (locked, dirty, open in other VS Code windows) after one confirmation.
- Delete several branches at once: multi-select in Delete Branch… (`Ctrl+Alt+Shift+D`) or checkboxes in the Branches & Worktrees view.
- Branches sorted by age, oldest first; branches whose upstream is gone but whose changes are not in the default branch are listed as unmerged.
- Long branch names are shortened to their last segment in the Branches & Worktrees view.
- Clean up merged, squash-merged and upstream-gone branches in bulk.
- Branches & Worktrees view in the Source Control side bar.

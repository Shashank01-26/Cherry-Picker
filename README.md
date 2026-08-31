# Cherry Picker

Visually cherry-pick commits across branches — no more memorizing SHAs or juggling `git cherry-pick` in the terminal.

Cherry Picker gives you a guided, 3-step panel for picking commits from one branch (say, your feature branch) onto another (`qa`, `uat`, `stg`, `prod`, or any branch you maintain), with built-in conflict resolution and one-click push.

## Features

**🌳 Branch sidebar**
A dedicated activity bar view lists your repository's branches. Click one to jump straight into the cherry-pick panel with that branch preset as your target.

**🔀 Guided 3-step workflow**
- **Step 1 — Compare Branches**: pick a source and target branch.
- **Step 2 — Select Commits**: browse the commits that exist on the source but not the target, and check off exactly the ones you want.
- **Step 3 — Cherry-Pick onto Target**: apply the selected commits in order, with an option to push the result to `origin` automatically.

**📄 Inline diff viewing**
Inspect the files changed by any commit — and view diffs at a specific commit — without leaving VS Code.

**⚠️ Conflict resolution, built in**
When a cherry-pick hits a conflict, Cherry Picker pauses and shows you exactly which files need attention. Resolve them in the editor, then:
- **Continue** the cherry-pick,
- **Commit and Push** once everything's resolved,
- **Skip** a commit that's a no-op on the target,
- **Commit Empty** when a fix already exists on the target and the conflict resolves to no changes, or
- **Abort** to cleanly back out of the whole operation.

**🔄 Live branch refresh**
Refresh the branch list at any time — from the sidebar or the panel — to pick up new branches without reloading the window.

## Getting Started

1. Open a folder that's a git repository.
2. Click the **Cherry Picker** icon in the activity bar, or run **Cherry Picker: Open Cherry Picker** from the Command Palette.
3. Pick your source and target branches, select the commits you need, and cherry-pick.

## Requirements

- A git repository open as your VS Code workspace (single-folder workspaces are supported; with multiple folders open, Cherry Picker operates on the first one).
- Git installed and available on your `PATH`.

## Commands

| Command | Description |
|---|---|
| `Cherry Picker: Open Cherry Picker` | Opens the cherry-pick panel |
| `Cherry Picker: Refresh Branches` | Refreshes the branch list in the sidebar and panel |

## Known Limitations

- Multi-root workspaces are only partially supported — Cherry Picker targets the first workspace folder.

## Feedback & Contributions

Found a bug or have a feature request? Open an issue on the [GitHub repository](https://github.com/Shashank01-26/Cherry-Picker).

## License

[MIT](LICENSE)

import * as vscode from 'vscode';
import * as path from 'path';
import { GitService, CherryPickConflict } from './GitService';

export class CherryPickPanel {
  public static currentPanel: CherryPickPanel | undefined;
  private static readonly viewType = 'cherryPicker';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _git: GitService;
  private _disposables: vscode.Disposable[] = [];
  private _conflictState: CherryPickConflict | undefined;

  public static createOrShow(extensionUri: vscode.Uri, git: GitService, presetTargetBranch?: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (CherryPickPanel.currentPanel) {
      CherryPickPanel.currentPanel._panel.reveal(column);
      // Don't blow away an in-progress conflict resolution with a full
      // re-render — just reveal what's already on screen.
      if (!CherryPickPanel.currentPanel._conflictState) {
        CherryPickPanel.currentPanel._refresh(presetTargetBranch);
      } else if (presetTargetBranch) {
        CherryPickPanel.currentPanel._panel.webview.postMessage({ command: 'presetTarget', branch: presetTargetBranch });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CherryPickPanel.viewType,
      'Cherry Picker',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );

    CherryPickPanel.currentPanel = new CherryPickPanel(panel, git, presetTargetBranch);
  }

  private constructor(panel: vscode.WebviewPanel, git: GitService, presetTargetBranch?: string) {
    this._panel = panel;
    this._git = git;

    this._panel.iconPath = new vscode.ThemeIcon('git-merge');
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables
    );

    // Keep the branch dropdowns fresh: re-fetch from origin whenever the
    // panel regains focus, not just at initial creation.
    this._panel.onDidChangeViewState(e => {
      if (e.webviewPanel.visible) {
        this._pushBranches(false);
      }
    }, null, this._disposables);

    this._refresh(presetTargetBranch);
  }

  private _refresh(presetTargetBranch?: string) {
    const branches = this._git.getAllBranches();
    const currentBranch = this._git.getCurrentBranch();
    const repoName = this._git.getRepoName();
    this._panel.webview.html = this._getHtml(branches, currentBranch, repoName, presetTargetBranch);
  }

  /** Called by the sidebar's "Refresh Branches" command. */
  public refreshBranches() {
    this._pushBranches(true);
  }

  /**
   * Re-fetches origin and pushes an updated branch list into the webview
   * without a full page reload, so the dropdowns stay current even if the
   * panel has been open a while (e.g. a teammate pushed a new branch).
   */
  private _pushBranches(showWarningOnFailure: boolean) {
    const fetchOk = this._git.refreshRemotes();
    try {
      const branches = this._git.getAllBranches();
      const currentBranch = this._git.getCurrentBranch();
      this._panel.webview.postMessage({ command: 'branchesLoaded', branches, currentBranch });
      if (!fetchOk && showWarningOnFailure) {
        this._panel.webview.postMessage({ command: 'error', message: 'Could not reach origin to refresh branches — showing the last known list.' });
      }
    } catch (err: any) {
      if (showWarningOnFailure) {
        this._panel.webview.postMessage({ command: 'error', message: err.message });
      }
    }
  }

  private async _handleMessage(msg: any) {
    switch (msg.command) {
      case 'getCommits': {
        const { sourceBranch, targetBranch } = msg;
        try {
          const commits = this._git.getCommitsBetween(sourceBranch, targetBranch);
          this._panel.webview.postMessage({ command: 'commitsLoaded', commits });
        } catch (err: any) {
          this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'cherryPick': {
        const { targetBranch, commits, push, commitMessage } = msg;

        if (!commits || commits.length === 0) {
          this._panel.webview.postMessage({ command: 'error', message: 'Select at least one commit.' });
          return;
        }
        if (!targetBranch) {
          this._panel.webview.postMessage({ command: 'error', message: 'Target branch is required.' });
          return;
        }

        this._panel.webview.postMessage({ command: 'progress', message: `Cherry-picking ${commits.length} commit(s) onto "${targetBranch}"...` });

        const result = await this._git.cherryPickCommits(targetBranch, commits, push, commitMessage || undefined);
        this._handleCherryPickResult(result);
        break;
      }

      case 'openConflictFile': {
        const absPath = path.join(this._git.getRepoRoot(), msg.filePath);
        const uri = vscode.Uri.file(absPath);
        try {
          // Cherry-pick conflicts are real git merge conflicts under the hood
          // (same index stages) — open VS Code's native 3-way Merge Editor
          // instead of a plain text editor showing raw conflict markers.
          await vscode.commands.executeCommand('git.openMergeEditor', uri);
        } catch {
          vscode.window.showTextDocument(uri, { preview: false });
        }
        break;
      }

      case 'continueResolve': {
        this._continueResolve(false);
        break;
      }

      case 'commitAndPushResolve': {
        this._continueResolve(true);
        break;
      }

      case 'skipCommit': {
        if (!this._conflictState) {
          this._panel.webview.postMessage({ command: 'error', message: 'No active conflict to skip.' });
          return;
        }
        try {
          const result = this._git.skipCurrentCommit(this._conflictState);
          this._handleCherryPickResult(result);
        } catch (err: any) {
          this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'commitEmpty': {
        if (!this._conflictState) {
          this._panel.webview.postMessage({ command: 'error', message: 'No active conflict to commit.' });
          return;
        }
        try {
          const result = this._git.commitCurrentAsEmpty(this._conflictState);
          this._handleCherryPickResult(result);
        } catch (err: any) {
          this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'abortResolve': {
        if (!this._conflictState) {
          this._panel.webview.postMessage({ command: 'error', message: 'No active conflict to abort.' });
          return;
        }
        const abortResult = this._git.abortCherryPick(this._conflictState);
        this._conflictState = undefined;
        this._panel.webview.postMessage({ command: 'conflictResolved' });
        this._panel.webview.postMessage({ command: 'cherryPickDone', result: abortResult });
        break;
      }

      case 'refreshConflicts': {
        if (!this._conflictState) { return; }
        const files = this._git.getConflictedFiles();
        this._panel.webview.postMessage({ command: 'conflictsRefreshed', files });
        break;
      }

      case 'getCommitFiles': {
        try {
          const files = this._git.getCommitFiles(msg.hash);
          this._panel.webview.postMessage({ command: 'commitFilesLoaded', hash: msg.hash, files });
        } catch (err: any) {
          this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'openDiff': {
        const { hash, filePath } = msg;
        // Built via Uri.from (structured components) rather than Uri.parse on a
        // raw interpolated string, so a filePath containing '#', '?', or '%'
        // can't be misparsed into the wrong scheme/path/query/fragment.
        const left = vscode.Uri.from({ scheme: 'cherry-picker-git', path: '/' + filePath, query: `${hash}~1` });
        const right = vscode.Uri.from({ scheme: 'cherry-picker-git', path: '/' + filePath, query: hash });
        const title = `${filePath} (${hash.substring(0, 7)})`;
        vscode.commands.executeCommand('vscode.diff', left, right, title);
        break;
      }

      case 'getBranches': {
        this._pushBranches(true);
        break;
      }

      case 'refresh': {
        this._refresh();
        break;
      }
    }
  }

  /**
   * Resolve the current conflict and continue the cherry-pick sequence.
   * `forcePush` upgrades this session's push flag so that once the whole
   * batch completes (immediately, or after further conflicts), it auto-pushes.
   */
  private _continueResolve(forcePush: boolean) {
    if (!this._conflictState) {
      this._panel.webview.postMessage({ command: 'error', message: 'No active conflict to continue.' });
      return;
    }
    try {
      const state = forcePush ? { ...this._conflictState, push: true } : this._conflictState;
      const result = this._git.continueCherryPick(state);
      if (result.status === 'conflict') {
        this._conflictState = result;
        this._panel.webview.postMessage({
          command: 'conflictDetected',
          conflictedFiles: result.conflictedFiles,
          commitHash: result.currentCommitHash,
          pickedSoFar: result.pickedSoFar,
          totalCommits: result.allCommits.length,
          targetBranch: result.targetBranch,
          emptyCommit: result.emptyCommit,
        });
        if (result.emptyCommit) {
          this._panel.webview.postMessage({ command: 'progress', message: 'This commit introduces no changes on the target branch — choose Skip or Commit as Empty below.' });
        } else {
          const pushNote = forcePush ? ' Nothing was committed or pushed.' : '';
          this._panel.webview.postMessage({ command: 'error', message: `${result.conflictedFiles.length} file(s) still have unresolved conflicts. Open them, resolve the markers, and save before continuing.${pushNote}` });
        }
      } else {
        this._handleCherryPickResult(result);
      }
    } catch (err: any) {
      this._panel.webview.postMessage({ command: 'error', message: err.message });
    }
  }

  private _handleCherryPickResult(result: import('./GitService').CherryPickResult | import('./GitService').CherryPickConflict) {
    if (result.status === 'conflict') {
      this._conflictState = result;
      this._panel.webview.postMessage({
        command: 'conflictDetected',
        conflictedFiles: result.conflictedFiles,
        commitHash: result.currentCommitHash,
        pickedSoFar: result.pickedSoFar,
        totalCommits: result.allCommits.length,
        targetBranch: result.targetBranch,
        emptyCommit: result.emptyCommit,
      });
    } else {
      this._conflictState = undefined;
      this._panel.webview.postMessage({ command: 'conflictResolved' });
      this._panel.webview.postMessage({ command: 'cherryPickDone', result });
    }
  }

  private _getHtml(branches: string[], currentBranch: string, repoName: string, presetTargetBranch?: string): string {
    // Suggest default target branches
    const envBranches = ['prod', 'stg', 'uat', 'qa', 'main', 'master', 'develop'];
    let defaultTarget = envBranches.find(b => branches.includes(b) && b !== currentBranch) ?? branches[0] ?? '';
    if (presetTargetBranch && presetTargetBranch !== currentBranch && branches.includes(presetTargetBranch)) {
      defaultTarget = presetTargetBranch;
    }

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cherry Picker</title>
<style>
  :root {
    --radius: 6px;
    --gap: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 100vh;
  }
  h1 {
    font-size: 1.1em;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--vscode-foreground);
    border-bottom: 1px solid var(--vscode-panel-border);
    padding-bottom: 10px;
  }
  h1 .repo { font-size: 0.85em; font-weight: 400; opacity: 0.6; margin-left: 4px; }
  .card {
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: var(--gap);
  }
  .card h2 { font-size: 0.9em; font-weight: 600; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.04em; }
  .row { display: flex; gap: var(--gap); align-items: flex-end; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 140px; }
  label { font-size: 0.82em; opacity: 0.7; font-weight: 500; }
  select, input[type="text"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 0.9em;
    font-family: inherit;
    outline: none;
    width: 100%;
  }
  select:focus, input:focus {
    border-color: var(--vscode-focusBorder);
  }
  button {
    padding: 7px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.88em;
    font-family: inherit;
    font-weight: 500;
    white-space: nowrap;
    transition: opacity 0.15s;
  }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  button:hover:not(:disabled) { opacity: 0.85; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .btn-success {
    background: #2ea043;
    color: #fff;
  }
  .btn-danger {
    background: #da3633;
    color: #fff;
  }
  /* Commit list */
  #commit-section { display: none; }
  .commit-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .commit-count { font-size: 0.82em; opacity: 0.6; margin-left: auto; }
  .commit-list {
    max-height: 380px;
    overflow-y: auto;
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
  }
  .commit-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    transition: background 0.1s;
  }
  .commit-item:last-child { border-bottom: none; }
  .commit-item:hover { background: var(--vscode-list-hoverBackground); }
  .commit-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .commit-item input[type="checkbox"] { margin-top: 3px; flex-shrink: 0; cursor: pointer; }
  .commit-info { flex: 1; min-width: 0; }
  .commit-msg {
    font-size: 0.88em;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .commit-meta { font-size: 0.76em; opacity: 0.55; margin-top: 2px; display: flex; gap: 10px; }
  .commit-hash {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.82em;
    opacity: 0.5;
    flex-shrink: 0;
    padding-top: 2px;
  }
  /* Status / log */
  #status-bar {
    display: none;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 14px;
    border-radius: var(--radius);
    font-size: 0.88em;
    line-height: 1.5;
    border: 1px solid transparent;
  }
  #status-bar-text { flex: 1; }
  #status-bar-close {
    background: transparent;
    border: none;
    padding: 0 2px;
    margin: 0;
    font-size: 1.1em;
    line-height: 1.4;
    opacity: 0.6;
    cursor: pointer;
    color: inherit;
  }
  #status-bar-close:hover { opacity: 1; }
  #status-bar.info  { background: var(--vscode-inputValidation-infoBackground, #1a3a5c); border-color: var(--vscode-inputValidation-infoBorder, #007acc); color: var(--vscode-inputValidation-infoForeground, var(--vscode-foreground)); }
  #status-bar.error { background: var(--vscode-inputValidation-errorBackground, #5c1a1a); border-color: var(--vscode-inputValidation-errorBorder, #da3633); }
  #status-bar.success { background: rgba(46,160,67,0.15); border-color: #2ea043; }
  #status-bar.progress { background: rgba(255,165,0,0.1); border-color: orange; }
  .empty-state {
    text-align: center;
    padding: 32px;
    opacity: 0.5;
    font-size: 0.9em;
  }
  .tag {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 0.75em;
    font-weight: 600;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    margin-left: 4px;
  }
  .cherry-icon { font-size: 1.3em; }
  /* Searchable dropdown */
  .search-select { position: relative; }
  .search-select input.ss-input {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 0.9em;
    font-family: inherit;
    outline: none;
    width: 100%;
  }
  .search-select input.ss-input:focus { border-color: var(--vscode-focusBorder); }
  .ss-dropdown {
    display: none;
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    max-height: 200px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-focusBorder);
    border-top: none;
    border-radius: 0 0 4px 4px;
    z-index: 100;
  }
  .ss-dropdown.open { display: block; }
  .ss-option {
    padding: 5px 8px;
    font-size: 0.88em;
    cursor: pointer;
  }
  .ss-option:hover, .ss-option.highlighted {
    background: var(--vscode-list-hoverBackground);
  }
  .ss-option.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .ss-no-match { padding: 8px; font-size: 0.82em; opacity: 0.5; text-align: center; }
  /* File changes per commit */
  .file-changes {
    display: none;
    padding: 4px 12px 8px 38px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
  }
  .file-changes.open { display: block; }
  .file-item {
    padding: 3px 6px;
    font-size: 0.82em;
    cursor: pointer;
    border-radius: 3px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .file-item:hover { background: var(--vscode-list-hoverBackground); }
  .file-status { font-weight: 600; font-size: 0.8em; width: 14px; text-align: center; }
  .file-status.A { color: #2ea043; }
  .file-status.M { color: #d29922; }
  .file-status.D { color: #da3633; }
  .file-status.R { color: #1f6feb; }
  .btn-view-changes {
    padding: 2px 8px;
    font-size: 0.76em;
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .btn-view-changes:hover { opacity: 0.85; }
  /* Conflict resolution */
  #conflict-section { display: none; }
  .conflict-msg { font-size: 0.88em; opacity: 0.85; line-height: 1.5; }
  .conflict-file-list {
    max-height: 200px;
    overflow-y: auto;
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--radius);
  }
  .conflict-file-item {
    padding: 7px 12px;
    font-size: 0.85em;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .conflict-file-item:last-child { border-bottom: none; }
  .conflict-file-item:hover { background: var(--vscode-list-hoverBackground); }
  .conflict-icon { color: #d29922; font-weight: 600; }
</style>
</head>
<body>

<h1>
  <span class="cherry-icon">🍒</span>
  Cherry Picker
  <span class="repo">${repoName}</span>
</h1>

<!-- Step 1: Branch selection -->
<div class="card">
  <h2>Step 1 — Compare Branches</h2>
  <div class="row">
    <div class="field">
      <label>Source Branch <small>(has the commits you want)</small></label>
      <div class="search-select" data-id="sourceBranch" data-default="${currentBranch}">
        <input class="ss-input" type="text" placeholder="Search branches..." value="${currentBranch}" />
        <div class="ss-dropdown"></div>
      </div>
    </div>
    <div class="field">
      <label>Target Branch <small>(missing those commits)</small></label>
      <div class="search-select" data-id="targetBranch" data-default="${defaultTarget}">
        <input class="ss-input" type="text" placeholder="Search branches..." value="${defaultTarget}" />
        <div class="ss-dropdown"></div>
      </div>
    </div>
    <button class="btn-secondary" id="btnRefreshBranches" onclick="refreshBranches()" title="Re-fetch the branch list from origin" style="font-size:1.3em; line-height:1; padding:7px 14px;">⟳</button>
    <button class="btn-primary" id="btnCompare" onclick="loadCommits()">Compare</button>
  </div>
</div>

<!-- Step 2: Commit selection -->
<div class="card" id="commit-section">
  <h2>Step 2 — Select Commits to Cherry-Pick</h2>
  <div class="commit-toolbar">
    <button class="btn-secondary" onclick="selectAll()">Select All</button>
    <button class="btn-secondary" onclick="selectNone()">Clear</button>
    <span class="commit-count" id="selectionCount">0 selected</span>
  </div>
  <div class="commit-list" id="commitList">
    <div class="empty-state">Loading commits...</div>
  </div>
</div>

<!-- Step 3: Cherry-pick onto target -->
<div class="card" id="action-section" style="display:none">
  <h2>Step 3 — Cherry-Pick onto Target Branch</h2>
  <p style="font-size:0.85em;opacity:0.7;">Selected commits will be cherry-picked directly onto <strong id="targetBranchLabel"></strong>.</p>
  <div class="field">
    <label>Commit Message <small>(optional — overrides original commit messages)</small></label>
    <input type="text" id="commitMessage" placeholder="Leave empty to keep original commit messages" />
  </div>
  <div class="row">
    <button class="btn-success" id="btnCherryPick" onclick="doCherryPick(false)">
      🍒 Cherry-Pick
    </button>
    <button class="btn-primary" id="btnCherryPickPush" onclick="doCherryPick(true)">
      🍒 Cherry-Pick &amp; Push
    </button>
  </div>
</div>

<!-- Conflict Resolution -->
<div class="card" id="conflict-section">
  <h2>Conflict Resolution</h2>
  <p class="conflict-msg" id="conflict-msg"></p>
  <div class="conflict-file-list" id="conflictFileList"></div>
  <div class="row" id="conflict-normal-actions" style="margin-top:4px;">
    <button class="btn-secondary" onclick="refreshConflicts()">Refresh</button>
    <button class="btn-success" onclick="continueResolve()">Continue Cherry-Pick</button>
    <button class="btn-primary" onclick="commitAndPushResolve()" title="Resolve this commit, continue the cherry-pick, and push once complete">Commit and Push</button>
    <button class="btn-danger" onclick="abortResolve()">Abort</button>
  </div>
  <div class="row" id="conflict-empty-actions" style="margin-top:4px; display:none;">
    <button class="btn-secondary" onclick="skipCommit()">Skip This Commit</button>
    <button class="btn-success" onclick="commitEmpty()">Commit as Empty</button>
    <button class="btn-danger" onclick="abortResolve()">Abort</button>
  </div>
</div>

<!-- Status -->
<div id="status-bar">
  <span id="status-bar-text"></span>
  <button id="status-bar-close" onclick="hideStatus()" title="Dismiss">&times;</button>
</div>

<script>
const vscode = acquireVsCodeApi();
let allCommits = [];
let selectedHashes = new Set();
let ALL_BRANCHES = ${JSON.stringify(branches)};

// ── Searchable dropdown logic ──
const ssValues = {}; // stores selected values by data-id

function initSearchSelects() {
  document.querySelectorAll('.search-select').forEach(wrapper => {
    const id = wrapper.dataset.id;
    const input = wrapper.querySelector('.ss-input');
    const dropdown = wrapper.querySelector('.ss-dropdown');
    ssValues[id] = wrapper.dataset.default || '';

    input.addEventListener('focus', () => openDropdown(wrapper));
    input.addEventListener('input', () => {
      ssValues[id] = ''; // clear selection while typing
      openDropdown(wrapper);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeAllDropdowns(); input.blur(); }
      if (e.key === 'Enter') {
        const first = dropdown.querySelector('.ss-option');
        if (first) { selectOption(wrapper, first.dataset.value); }
      }
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-select')) closeAllDropdowns();
  });
}

function openDropdown(wrapper) {
  closeAllDropdowns();
  const input = wrapper.querySelector('.ss-input');
  const dropdown = wrapper.querySelector('.ss-dropdown');
  const filter = input.value.toLowerCase();
  const id = wrapper.dataset.id;
  const matches = ALL_BRANCHES.filter(b => b.toLowerCase().includes(filter));

  if (matches.length === 0) {
    dropdown.innerHTML = '<div class="ss-no-match">No matching branches</div>';
  } else {
    dropdown.innerHTML = matches.map(b =>
      '<div class="ss-option' + (b === ssValues[id] ? ' active' : '') + '" data-value="' + escHtml(b) + '">' + escHtml(b) + '</div>'
    ).join('');
    dropdown.querySelectorAll('.ss-option').forEach(opt => {
      opt.addEventListener('click', () => selectOption(wrapper, opt.dataset.value));
    });
  }
  dropdown.classList.add('open');
}

function selectOption(wrapper, value) {
  const id = wrapper.dataset.id;
  const input = wrapper.querySelector('.ss-input');
  ssValues[id] = value;
  input.value = value;
  closeAllDropdowns();
}

function closeAllDropdowns() {
  document.querySelectorAll('.ss-dropdown').forEach(d => d.classList.remove('open'));
}

function getSSValue(id) {
  return ssValues[id] || '';
}

function setSSValue(id, value) {
  ssValues[id] = value;
  const wrapper = document.querySelector('.search-select[data-id="' + id + '"]');
  if (wrapper) { wrapper.querySelector('.ss-input').value = value; }
}

// ── Core logic ──

function loadCommits() {
  const source = getSSValue('sourceBranch');
  const target = getSSValue('targetBranch');
  if (!source || !target) {
    showStatus('Please select both source and target branches.', 'error');
    return;
  }
  if (source === target) {
    showStatus('Source and target branch must be different.', 'error');
    return;
  }
  document.getElementById('commit-section').style.display = 'flex';
  document.getElementById('action-section').style.display = 'none';
  document.getElementById('commitList').innerHTML = '<div class="empty-state">Fetching commits...</div>';
  showStatus('Comparing branches, this may take a moment...', 'progress');
  vscode.postMessage({ command: 'getCommits', sourceBranch: source, targetBranch: target });
}

function renderCommits(commits) {
  allCommits = commits;
  selectedHashes = new Set();
  const list = document.getElementById('commitList');

  if (!commits.length) {
    list.innerHTML = '<div class="empty-state">No unique commits found in source branch.<br>The branches may already be in sync.</div>';
    document.getElementById('action-section').style.display = 'none';
    hideStatus();
    return;
  }

  list.innerHTML = commits.map(c => \`
    <div class="commit-item" data-hash="\${c.hash}" onclick="toggleCommit('\${c.hash}', event)">
      <input type="checkbox" data-hash="\${c.hash}" onclick="toggleCommit('\${c.hash}', event)" />
      <div class="commit-info">
        <div class="commit-msg">\${escHtml(c.message)}</div>
        <div class="commit-meta">
          <span>\${escHtml(c.author)}</span>
          <span>\${escHtml(c.date)}</span>
          <span>\${escHtml(c.relativeDate)}</span>
        </div>
      </div>
      <button class="btn-view-changes" onclick="viewChanges('\${c.hash}', event)">View Changes</button>
      <span class="commit-hash">\${c.shortHash}</span>
    </div>
    <div class="file-changes" id="files-\${c.hash}"></div>
  \`).join('');

  updateCount();
  document.getElementById('action-section').style.display = 'flex';
  document.getElementById('targetBranchLabel').textContent = getSSValue('targetBranch');

  hideStatus();
}

function toggleCommit(hash, event) {
  event.stopPropagation();
  const item = document.querySelector(\`.commit-item[data-hash="\${hash}"]\`);
  const cb = item.querySelector('input[type="checkbox"]');
  if (event.target.tagName === 'INPUT') {
    if (cb.checked) selectedHashes.add(hash);
    else selectedHashes.delete(hash);
  } else {
    cb.checked = !cb.checked;
    if (cb.checked) selectedHashes.add(hash);
    else selectedHashes.delete(hash);
  }
  item.classList.toggle('selected', selectedHashes.has(hash));
  updateCount();
}

function selectAll() {
  allCommits.forEach(c => selectedHashes.add(c.hash));
  document.querySelectorAll('.commit-item').forEach(item => {
    item.querySelector('input[type="checkbox"]').checked = true;
    item.classList.add('selected');
  });
  updateCount();
}

function selectNone() {
  selectedHashes.clear();
  document.querySelectorAll('.commit-item').forEach(item => {
    item.querySelector('input[type="checkbox"]').checked = false;
    item.classList.remove('selected');
  });
  updateCount();
}

function updateCount() {
  document.getElementById('selectionCount').textContent = selectedHashes.size + ' of ' + allCommits.length + ' selected';
}

function doCherryPick(push) {
  const targetBranch = getSSValue('targetBranch');

  if (!targetBranch) { showStatus('Please select a target branch.', 'error'); return; }
  if (selectedHashes.size === 0) { showStatus('Please select at least one commit.', 'error'); return; }

  const commits = allCommits
    .filter(c => selectedHashes.has(c.hash))
    .map(c => c.hash)
    .reverse();

  const commitMessage = document.getElementById('commitMessage').value.trim();

  setBusy(true);
  vscode.postMessage({ command: 'cherryPick', targetBranch, commits, push, commitMessage });
}

function setBusy(busy) {
  document.getElementById('btnCherryPick').disabled = busy;
  document.getElementById('btnCherryPickPush').disabled = busy;
  document.getElementById('btnCompare').disabled = busy;
}

function showStatus(msg, type) {
  const bar = document.getElementById('status-bar');
  document.getElementById('status-bar-text').textContent = msg;
  bar.className = type;
  bar.style.display = 'flex';
}
function hideStatus() {
  document.getElementById('status-bar').style.display = 'none';
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.command) {
    case 'commitsLoaded':
      renderCommits(msg.commits);
      break;
    case 'error':
      showStatus('Error: ' + msg.message, 'error');
      setBusy(false);
      break;
    case 'progress':
      showStatus(msg.message, 'progress');
      break;
    case 'cherryPickDone': {
      setBusy(false);
      const r = msg.result;
      if (r.status === 'success') {
        showStatus(
          '✅ ' + r.pickedCount + ' commit(s) cherry-picked onto "' + r.targetBranch + '" successfully.',
          'success'
        );
        // The target branch just changed — this commit list is now stale.
        // Force a fresh Compare before allowing another pick.
        allCommits = [];
        selectedHashes = new Set();
        document.getElementById('commit-section').style.display = 'none';
        document.getElementById('action-section').style.display = 'none';
      } else {
        showStatus('❌ ' + (r.error || 'Cherry-pick failed.'), 'error');
      }
      break;
    }
    case 'conflictDetected':
      showConflictUI(msg);
      setBusy(false);
      break;
    case 'conflictsRefreshed':
      renderConflictFiles(msg.files);
      break;
    case 'conflictResolved':
      hideConflictUI();
      break;
    case 'commitFilesLoaded':
      renderFileChanges(msg.hash, msg.files);
      break;
    case 'branchesLoaded':
      ALL_BRANCHES = msg.branches;
      break;
    case 'presetTarget':
      setSSValue('targetBranch', msg.branch);
      break;
  }
});

// ── Conflict resolution ──

function showConflictUI(data) {
  document.getElementById('conflict-section').style.display = 'flex';
  document.getElementById('action-section').style.display = 'none';

  const fileList = document.getElementById('conflictFileList');
  const normalActions = document.getElementById('conflict-normal-actions');
  const emptyActions = document.getElementById('conflict-empty-actions');

  if (data.emptyCommit) {
    document.getElementById('conflict-msg').innerHTML =
      'Commit <strong>' + escHtml(data.commitHash.substring(0, 7)) + '</strong> introduces no changes on <strong>' + escHtml(data.targetBranch) + '</strong> after conflict resolution — the fix likely already exists there ' +
      '(' + data.pickedSoFar + ' of ' + data.totalCommits + ' picked so far).<br>' +
      '<strong>Skip</strong> to drop this commit, or <strong>Commit as Empty</strong> to keep a record of it in history.';
    fileList.style.display = 'none';
    normalActions.style.display = 'none';
    emptyActions.style.display = 'flex';
  } else {
    document.getElementById('conflict-msg').innerHTML =
      'Cherry-picking commit <strong>' + escHtml(data.commitHash.substring(0, 7)) + '</strong> onto <strong>' + escHtml(data.targetBranch) + '</strong> ' +
      '(' + data.pickedSoFar + ' of ' + data.totalCommits + ' picked so far).<br>' +
      'Click the files below to open them in the editor, resolve the conflict markers, <strong>save the file</strong>, then click <strong>Continue</strong>.';
    fileList.style.display = 'block';
    normalActions.style.display = 'flex';
    emptyActions.style.display = 'none';
    renderConflictFiles(data.conflictedFiles);
  }
  hideStatus();
}

function skipCommit() {
  showStatus('Skipping empty commit...', 'progress');
  vscode.postMessage({ command: 'skipCommit' });
}

function commitEmpty() {
  showStatus('Committing as empty...', 'progress');
  vscode.postMessage({ command: 'commitEmpty' });
}

function renderConflictFiles(files) {
  var list = document.getElementById('conflictFileList');
  if (!files.length) {
    list.innerHTML = '<div style="padding:8px;opacity:0.5;font-size:0.85em;text-align:center;">All conflicts resolved. Click Continue.</div>';
    return;
  }
  list.innerHTML = files.map(function(f) {
    return '<div class="conflict-file-item" data-filepath="' + escHtml(f) + '">'
      + '<span class="conflict-icon">!</span>'
      + '<span>' + escHtml(f) + '</span>'
      + '</div>';
  }).join('');
  // Attach click handlers via event delegation
  list.querySelectorAll('.conflict-file-item').forEach(function(item) {
    item.addEventListener('click', function() {
      vscode.postMessage({ command: 'openConflictFile', filePath: item.dataset.filepath });
    });
  });
}

function refreshConflicts() {
  vscode.postMessage({ command: 'refreshConflicts' });
}

function continueResolve() {
  showStatus('Continuing cherry-pick...', 'progress');
  vscode.postMessage({ command: 'continueResolve' });
}

function commitAndPushResolve() {
  showStatus('Continuing cherry-pick and preparing to push...', 'progress');
  vscode.postMessage({ command: 'commitAndPushResolve' });
}

function abortResolve() {
  showStatus('Aborting cherry-pick...', 'progress');
  vscode.postMessage({ command: 'abortResolve' });
}

function hideConflictUI() {
  document.getElementById('conflict-section').style.display = 'none';
  // Restore the cherry-pick buttons so the user can retry without re-comparing
  if (allCommits.length > 0) {
    document.getElementById('action-section').style.display = 'flex';
  }
}

// ── View file changes ──

function viewChanges(hash, event) {
  event.stopPropagation();
  const container = document.getElementById('files-' + hash);
  if (container.classList.contains('open')) {
    container.classList.remove('open');
    return;
  }
  container.innerHTML = '<div style="padding:6px;opacity:0.5;font-size:0.82em;">Loading...</div>';
  container.classList.add('open');
  vscode.postMessage({ command: 'getCommitFiles', hash: hash });
}

function renderFileChanges(hash, files) {
  const container = document.getElementById('files-' + hash);
  if (!files.length) {
    container.innerHTML = '<div style="padding:6px;opacity:0.5;font-size:0.82em;">No file changes found.</div>';
    return;
  }
  container.innerHTML = files.map(function(f) {
    return '<div class="file-item" data-hash="' + escHtml(hash) + '" data-filepath="' + escHtml(f.path) + '" data-status="' + escHtml(f.status) + '">'
      + '<span class="file-status ' + escHtml(f.status) + '">' + escHtml(f.status) + '</span>'
      + '<span>' + escHtml(f.path) + '</span>'
      + '</div>';
  }).join('');
  container.querySelectorAll('.file-item').forEach(function(item) {
    item.addEventListener('click', function() {
      vscode.postMessage({ command: 'openDiff', hash: item.dataset.hash, filePath: item.dataset.filepath, status: item.dataset.status });
    });
  });
}

function refreshBranches() {
  showStatus('Refreshing branch list from origin...', 'progress');
  vscode.postMessage({ command: 'getBranches' });
}

// Init searchable dropdowns on load, and immediately re-fetch the branch
// list in case anything changed on origin since this panel was last opened.
initSearchSelects();
vscode.postMessage({ command: 'getBranches' });
</script>
</body>
</html>`;
  }

  public dispose() {
    if (this._conflictState) {
      this._git.abortCherryPick(this._conflictState);
      this._conflictState = undefined;
    }
    CherryPickPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}

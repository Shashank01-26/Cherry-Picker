import * as vscode from 'vscode';
import { GitService, CommitInfo } from './GitService';

export class CherryPickPanel {
  public static currentPanel: CherryPickPanel | undefined;
  private static readonly viewType = 'cherryPicker';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _git: GitService;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, git: GitService) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (CherryPickPanel.currentPanel) {
      CherryPickPanel.currentPanel._panel.reveal(column);
      CherryPickPanel.currentPanel._refresh();
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

    CherryPickPanel.currentPanel = new CherryPickPanel(panel, git);
  }

  private constructor(panel: vscode.WebviewPanel, git: GitService) {
    this._panel = panel;
    this._git = git;

    this._panel.iconPath = new vscode.ThemeIcon('git-merge');
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg),
      null,
      this._disposables
    );

    this._refresh();
  }

  private _refresh() {
    const branches = this._git.getAllBranches();
    const currentBranch = this._git.getCurrentBranch();
    const repoName = this._git.getRepoName();
    this._panel.webview.html = this._getHtml(branches, currentBranch, repoName);
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
        const { newBranch, baseBranch, commits, push } = msg;

        if (!newBranch || newBranch.trim() === '') {
          this._panel.webview.postMessage({ command: 'error', message: 'Feature branch name is required.' });
          return;
        }
        if (!commits || commits.length === 0) {
          this._panel.webview.postMessage({ command: 'error', message: 'Select at least one commit.' });
          return;
        }
        if (this._git.branchExists(newBranch)) {
          this._panel.webview.postMessage({ command: 'error', message: `Branch "${newBranch}" already exists. Choose a different name.` });
          return;
        }

        this._panel.webview.postMessage({ command: 'progress', message: `Creating branch "${newBranch}" from "${baseBranch}" and cherry-picking ${commits.length} commit(s)...` });

        const result = await this._git.cherryPickCommits(newBranch, baseBranch, commits, push);
        this._panel.webview.postMessage({ command: 'cherryPickDone', result });
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
        const left = vscode.Uri.parse(`cherry-picker-git:/${filePath}?${hash}~1`);
        const right = vscode.Uri.parse(`cherry-picker-git:/${filePath}?${hash}`);
        const title = `${filePath} (${hash.substring(0, 7)})`;
        vscode.commands.executeCommand('vscode.diff', left, right, title);
        break;
      }

      case 'push': {
        const { branch } = msg;
        try {
          this._panel.webview.postMessage({ command: 'progress', message: `Pushing "${branch}" to origin...` });
          await this._git.pushBranch(branch);
          this._panel.webview.postMessage({ command: 'pushDone', branch });
        } catch (err: any) {
          this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
        break;
      }

      case 'refresh': {
        this._refresh();
        break;
      }
    }
  }

  private _getHtml(branches: string[], currentBranch: string, repoName: string): string {
    // Suggest default target branches
    const envBranches = ['prod', 'stg', 'uat', 'qa', 'main', 'master', 'develop'];
    const defaultTarget = envBranches.find(b => branches.includes(b) && b !== currentBranch) ?? branches[0] ?? '';

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
    padding: 10px 14px;
    border-radius: var(--radius);
    font-size: 0.88em;
    line-height: 1.5;
    border: 1px solid transparent;
  }
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

<!-- Step 3: Create feature branch -->
<div class="card" id="action-section" style="display:none">
  <h2>Step 3 — Create Feature Branch &amp; Cherry-Pick</h2>
  <div class="row">
    <div class="field">
      <label for="newBranchName">New Feature Branch Name</label>
      <input type="text" id="newBranchName" placeholder="e.g. feature/cherry-pick-to-prod" />
    </div>
    <div class="field" style="max-width:220px">
      <label>Base Branch <small>(branch off from)</small></label>
      <div class="search-select" data-id="baseBranch" data-default="${defaultTarget}">
        <input class="ss-input" type="text" placeholder="Search branches..." value="${defaultTarget}" />
        <div class="ss-dropdown"></div>
      </div>
    </div>
  </div>
  <div class="row">
    <button class="btn-success" id="btnCherryPick" onclick="doCherryPick(false)">
      🍒 Cherry-Pick &amp; Create Branch
    </button>
    <button class="btn-primary" id="btnCherryPickPush" onclick="doCherryPick(true)">
      🍒 Cherry-Pick, Create &amp; Push
    </button>
  </div>
</div>

<!-- Status -->
<div id="status-bar"></div>

<script>
const vscode = acquireVsCodeApi();
let allCommits = [];
let selectedHashes = new Set();
const ALL_BRANCHES = ${JSON.stringify(branches)};

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

  // Default: set base branch to same as target
  const target = getSSValue('targetBranch');
  const baseWrapper = document.querySelector('.search-select[data-id="baseBranch"]');
  if (baseWrapper) selectOption(baseWrapper, target);
  document.getElementById('newBranchName').value = 'cherry-pick/' + target + '-' + Date.now().toString(36);

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
  const newBranch = document.getElementById('newBranchName').value.trim();
  const baseBranch = getSSValue('baseBranch');

  if (!newBranch) { showStatus('Please enter a feature branch name.', 'error'); return; }
  if (!baseBranch) { showStatus('Please select a base branch.', 'error'); return; }
  if (selectedHashes.size === 0) { showStatus('Please select at least one commit.', 'error'); return; }

  const commits = allCommits
    .filter(c => selectedHashes.has(c.hash))
    .map(c => c.hash)
    .reverse();

  setBusy(true);
  vscode.postMessage({ command: 'cherryPick', newBranch, baseBranch, commits, push });
}

function setBusy(busy) {
  document.getElementById('btnCherryPick').disabled = busy;
  document.getElementById('btnCherryPickPush').disabled = busy;
  document.getElementById('btnCompare').disabled = busy;
}

function showStatus(msg, type) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className = type;
  bar.style.display = 'block';
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
      if (r.success) {
        showStatus(
          '✅ Branch "' + r.branch + '" created with ' + r.pickedCount + ' cherry-picked commit(s).' +
          (r.conflicts.length ? ' ⚠️ Skipped: ' + r.conflicts.join(', ') : ''),
          'success'
        );
      } else {
        showStatus('❌ ' + (r.error || 'Cherry-pick failed.'), 'error');
      }
      break;
    }
    case 'commitFilesLoaded':
      renderFileChanges(msg.hash, msg.files);
      break;
    case 'pushDone':
      showStatus('✅ Branch "' + msg.branch + '" pushed to origin successfully.', 'success');
      setBusy(false);
      break;
  }
});

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
    var q = "&apos;";
    return '<div class="file-item" onclick="openDiff(' + q + escHtml(hash) + q + ', ' + q + escHtml(f.path) + q + ', ' + q + escHtml(f.status) + q + ')">'
      + '<span class="file-status ' + escHtml(f.status) + '">' + escHtml(f.status) + '</span>'
      + '<span>' + escHtml(f.path) + '</span>'
      + '</div>';
  }).join('');
}

function openDiff(hash, filePath, status) {
  vscode.postMessage({ command: 'openDiff', hash: hash, filePath: filePath, status: status });
}

// Init searchable dropdowns on load
initSearchSelects();
</script>
</body>
</html>`;
  }

  public dispose() {
    CherryPickPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}

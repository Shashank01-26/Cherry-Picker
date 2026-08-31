import * as vscode from 'vscode';
import { GitService } from './GitService';
import { CherryPickPanel } from './CherryPickPanel';
import { BranchTreeProvider } from './BranchTreeProvider';

export function activate(context: vscode.ExtensionContext) {
  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage('Cherry Picker: No workspace folder open.');
    return;
  }

  if (workspaceFolders.length > 1) {
    vscode.window.showInformationMessage(
      `Cherry Picker: Multiple workspace folders detected — operating on "${workspaceFolders[0].name}" only. Open that repo alone as your workspace to target a different one.`
    );
  }

  const outputChannel = vscode.window.createOutputChannel('Cherry Picker');
  context.subscriptions.push(outputChannel);

  const repoPath = workspaceFolders[0].uri.fsPath;
  const git = new GitService(repoPath, (msg) => outputChannel.appendLine(msg));

  if (!git.isGitRepo()) {
    vscode.window.showErrorMessage('Cherry Picker: No git repository found in the current workspace.');
    return;
  }

  // Content provider for viewing file diffs at specific commits
  const gitContentProvider = vscode.workspace.registerTextDocumentContentProvider('cherry-picker-git', {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const ref = uri.query;
      const filePath = uri.path.substring(1); // remove leading /
      return git.showFileAtCommit(ref, filePath);
    }
  });
  context.subscriptions.push(gitContentProvider);

  // Sidebar tree view
  const treeProvider = new BranchTreeProvider(git);
  const treeView = vscode.window.createTreeView('cherry-picker.branchView', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });
  context.subscriptions.push(treeView);

  // Open panel command — an optional branch name (from a sidebar click)
  // pre-selects that branch as the target in Step 1.
  const openCmd = vscode.commands.registerCommand('cherry-picker.open', (branchName?: string) => {
    CherryPickPanel.createOrShow(context.extensionUri, git, branchName);
  });

  // Refresh command
  const refreshCmd = vscode.commands.registerCommand('cherry-picker.refresh', () => {
    treeProvider.refresh();
    CherryPickPanel.currentPanel?.refreshBranches();
    vscode.window.showInformationMessage('Cherry Picker: Branches refreshed.');
  });

  context.subscriptions.push(openCmd, refreshCmd);

  // Auto-open when sidebar is focused
  context.subscriptions.push(
    treeView.onDidChangeVisibility(e => {
      if (e.visible) {
        treeProvider.refresh();
      }
    })
  );
}

export function deactivate() {}

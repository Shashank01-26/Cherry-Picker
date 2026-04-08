import * as vscode from 'vscode';
import { GitService } from './GitService';

export class BranchTreeProvider implements vscode.TreeDataProvider<BranchItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BranchItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private git: GitService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BranchItem): vscode.TreeItem {
    return element;
  }

  getChildren(): BranchItem[] {
    try {
      const current = this.git.getCurrentBranch();
      const branches = this.git.getAllBranches();

      return branches.map(b => {
        const item = new BranchItem(b, b === current);
        return item;
      });
    } catch {
      return [new BranchItem('No git repo found', false, true)];
    }
  }
}

class BranchItem extends vscode.TreeItem {
  constructor(
    public readonly branchName: string,
    public readonly isCurrent: boolean,
    public readonly isError = false
  ) {
    super(
      isCurrent ? `$(check) ${branchName}` : branchName,
      vscode.TreeItemCollapsibleState.None
    );

    if (isError) {
      this.iconPath = new vscode.ThemeIcon('error');
      return;
    }

    this.tooltip = isCurrent ? `${branchName} (current)` : branchName;
    this.description = isCurrent ? 'current' : '';
    this.iconPath = new vscode.ThemeIcon(
      isCurrent ? 'git-branch' : 'git-branch',
      isCurrent ? new vscode.ThemeColor('gitDecoration.addedResourceForeground') : undefined
    );

    this.command = {
      command: 'cherry-picker.open',
      title: 'Open Cherry Picker',
      arguments: [],
    };
  }
}

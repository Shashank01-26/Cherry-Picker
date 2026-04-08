import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  relativeDate: string;
}

export interface CommitFileChange {
  status: string;
  path: string;
}

export interface CherryPickResult {
  success: boolean;
  branch: string;
  pickedCount: number;
  conflicts: string[];
  error?: string;
}

export class GitService {
  constructor(private repoPath: string) {}

  private run(cmd: string): string {
    try {
      return execSync(cmd, {
        cwd: this.repoPath,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch (err: any) {
      throw new Error(err.stderr?.trim() || err.message);
    }
  }

  private async runAsync(cmd: string): Promise<string> {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: this.repoPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stderr && !stdout) {
      throw new Error(stderr.trim());
    }
    return stdout.trim();
  }

  isGitRepo(): boolean {
    try {
      this.run('git rev-parse --is-inside-work-tree');
      return true;
    } catch {
      return false;
    }
  }

  getCurrentBranch(): string {
    return this.run('git rev-parse --abbrev-ref HEAD');
  }

  getLocalBranches(): string[] {
    const out = this.run("git branch --format='%(refname:short)'");
    return out.split('\n').map(b => b.trim().replace(/^'|'$/g, '')).filter(Boolean);
  }

  getRemoteBranches(): string[] {
    try {
      // Fetch latest branch list from remote
      try { this.run('git fetch origin --prune --quiet'); } catch {}
      const out = this.run("git branch -r --format='%(refname:short)'");
      return out
        .split('\n')
        .map(b => b.trim().replace(/^'|'$/g, '').replace(/^origin\//, ''))
        .filter(b => b && !b.startsWith('HEAD'));
    } catch {
      return [];
    }
  }

  getAllBranches(): string[] {
    const local = this.getLocalBranches();
    const remote = this.getRemoteBranches();
    const all = new Set([...local, ...remote]);
    return Array.from(all).sort();
  }

  /**
   * Returns commits that exist in sourceBranch but NOT in targetBranch.
   * These are the candidates for cherry-picking into target.
   */
  getCommitsBetween(sourceBranch: string, targetBranch: string): CommitInfo[] {
    // Make sure we have latest info
    try { this.run(`git fetch origin "${sourceBranch}" --quiet`); } catch {}
    try { this.run(`git fetch origin "${targetBranch}" --quiet`); } catch {}

    const sourceSha = this.resolveToSha(sourceBranch);
    const targetSha = this.resolveToSha(targetBranch);

    const fmt = '%H|%h|%s|%an|%ad|%ar';
    const cmd = `git log ${sourceSha} ^${targetSha} --format="${fmt}" --date=short --no-merges`;
    const out = this.run(cmd);

    if (!out) return [];

    return out.split('\n').map(line => {
      const [hash, shortHash, message, author, date, relativeDate] = line.split('|');
      return { hash, shortHash, message, author, date, relativeDate };
    }).filter(c => c.hash);
  }

  /**
   * Resolves a branch name to its commit SHA using fully-qualified ref paths
   * (refs/heads/... or refs/remotes/origin/...) so git never confuses
   * branch names with file paths, regardless of slashes or special chars.
   */
  private resolveToSha(branch: string): string {
    // Try local branch first (refs/heads/...)
    try {
      return this.run(`git rev-parse --verify refs/heads/${branch}`);
    } catch {}
    // Try remote tracking branch (refs/remotes/origin/...)
    try {
      return this.run(`git rev-parse --verify refs/remotes/origin/${branch}`);
    } catch {}
    // Fallback: maybe it's already a SHA or tag
    try {
      return this.run(`git rev-parse --verify ${branch}`);
    } catch {
      throw new Error(`Cannot resolve branch "${branch}". Make sure it exists locally or on the remote.`);
    }
  }

  branchExists(branch: string): boolean {
    try {
      this.resolveToSha(branch);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new branch from baseBranch, then cherry-pick the given commits onto it.
   */
  async cherryPickCommits(
    newBranchName: string,
    baseBranch: string,
    commits: string[], // array of full commit hashes, oldest-first
    push: boolean
  ): Promise<CherryPickResult> {
    const conflicts: string[] = [];
    const originalBranch = this.getCurrentBranch();

    try {
      // Ensure base branch is up to date
      try { this.run(`git fetch origin "${baseBranch}" --quiet`); } catch {}

      const resolvedBase = this.resolveToSha(baseBranch);

      // Create and checkout new branch from baseBranch
      this.run(`git checkout -b "${newBranchName}" "${resolvedBase}"`);

      // Cherry-pick each commit
      for (const hash of commits) {
        try {
          this.run(`git cherry-pick ${hash}`);
        } catch (err: any) {
          // Abort the cherry-pick and record conflict
          try { this.run('git cherry-pick --abort'); } catch {}
          conflicts.push(hash.substring(0, 7));
          // Continue with remaining commits by skipping this one
          // We'll re-cherry-pick but skip conflict ones
        }
      }

      if (conflicts.length > 0) {
        // Checkout back and delete the partial branch
        this.run(`git checkout "${originalBranch}"`);
        try { this.run(`git branch -D "${newBranchName}"`); } catch {}
        return {
          success: false,
          branch: newBranchName,
          pickedCount: 0,
          conflicts,
          error: `Cherry-pick conflicts detected on commits: ${conflicts.join(', ')}. Resolve conflicts manually or deselect those commits.`,
        };
      }

      // Push if requested
      if (push) {
        this.run(`git push -u origin "${newBranchName}"`);
      }

      // Go back to original branch
      this.run(`git checkout "${originalBranch}"`);

      return {
        success: true,
        branch: newBranchName,
        pickedCount: commits.length - conflicts.length,
        conflicts,
      };
    } catch (err: any) {
      // Cleanup on unexpected error
      try { this.run(`git checkout "${originalBranch}"`); } catch {}
      try { this.run(`git cherry-pick --abort`); } catch {}
      try { this.run(`git branch -D "${newBranchName}"`); } catch {}
      return {
        success: false,
        branch: newBranchName,
        pickedCount: 0,
        conflicts,
        error: err.message,
      };
    }
  }

  async pushBranch(branchName: string): Promise<void> {
    await this.runAsync(`git push -u origin "${branchName}"`);
  }

  getCommitFiles(hash: string): CommitFileChange[] {
    const out = this.run(`git diff-tree --no-commit-id --name-status -r ${hash}`);
    if (!out) { return []; }
    return out.split('\n').map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.trim(), path: pathParts.join('\t').trim() };
    }).filter(f => f.path);
  }

  showFileAtCommit(ref: string, filePath: string): string {
    try {
      return this.run(`git show ${ref}:${filePath}`);
    } catch {
      return '';
    }
  }

  getRepoName(): string {
    try {
      const remote = this.run('git remote get-url origin');
      const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
      return match?.[1] ?? 'Unknown Repo';
    } catch {
      return 'Local Repo';
    }
  }
}

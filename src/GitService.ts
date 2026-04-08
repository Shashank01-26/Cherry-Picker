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
  status: 'success' | 'error';
  targetBranch: string;
  pickedCount: number;
  error?: string;
}

export interface CherryPickConflict {
  status: 'conflict';
  conflictedFiles: string[];
  currentCommitHash: string;
  currentCommitIndex: number;
  allCommits: string[];
  targetBranch: string;
  originalBranch: string;
  push: boolean;
  pickedSoFar: number;
}

export class GitService {
  public readonly repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

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
   * Cherry-pick commits directly onto the target branch.
   * Pauses on conflict instead of aborting, returning a CherryPickConflict state.
   */
  async cherryPickCommits(
    targetBranch: string,
    commits: string[],
    push: boolean
  ): Promise<CherryPickResult | CherryPickConflict> {
    const originalBranch = this.getCurrentBranch();

    try {
      try { this.run(`git fetch origin "${targetBranch}" --quiet`); } catch {}
      // Checkout the target branch directly
      this.run(`git checkout "${targetBranch}"`);
      // Pull latest to avoid conflicts with remote
      try { this.run(`git pull origin "${targetBranch}" --quiet`); } catch {}

      return this._pickCommitsFrom(0, commits, targetBranch, originalBranch, push, 0);
    } catch (err: any) {
      try { this.run(`git cherry-pick --abort`); } catch {}
      try { this.run(`git checkout "${originalBranch}"`); } catch {}
      return { status: 'error', targetBranch, pickedCount: 0, error: err.message };
    }
  }

  /**
   * Internal: pick commits starting from a given index. Returns conflict state if one is hit.
   */
  private _pickCommitsFrom(
    startIndex: number,
    allCommits: string[],
    targetBranch: string,
    originalBranch: string,
    push: boolean,
    pickedSoFar: number
  ): CherryPickResult | CherryPickConflict {
    for (let i = startIndex; i < allCommits.length; i++) {
      try {
        this.run(`git cherry-pick ${allCommits[i]}`);
        pickedSoFar++;
      } catch {
        // Conflict — don't abort, let user resolve
        const conflictedFiles = this.getConflictedFiles();
        return {
          status: 'conflict',
          conflictedFiles,
          currentCommitHash: allCommits[i],
          currentCommitIndex: i,
          allCommits,
          targetBranch,
          originalBranch,
          push,
          pickedSoFar,
        };
      }
    }

    // All commits picked successfully
    if (push) {
      this.run(`git push origin "${targetBranch}"`);
    }
    this.run(`git checkout "${originalBranch}"`);
    return { status: 'success', targetBranch, pickedCount: pickedSoFar };
  }

  /**
   * Continue cherry-pick after user resolves conflicts.
   * Stages all files, continues the cherry-pick, then processes remaining commits.
   */
  continueCherryPick(state: CherryPickConflict): CherryPickResult | CherryPickConflict {
    try {
      this.run('git add -A');
      execSync('git cherry-pick --continue', {
        cwd: this.repoPath,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_EDITOR: 'true' },
      });

      return this._pickCommitsFrom(
        state.currentCommitIndex + 1,
        state.allCommits,
        state.targetBranch,
        state.originalBranch,
        state.push,
        state.pickedSoFar + 1
      );
    } catch (err: any) {
      // cherry-pick --continue failed, probably unresolved conflicts remain
      const conflictedFiles = this.getConflictedFiles();
      if (conflictedFiles.length > 0) {
        return { ...state, conflictedFiles };
      }
      throw new Error(err.stderr?.trim() || err.message);
    }
  }

  /**
   * Abort cherry-pick, reset the target branch, and go back to original branch.
   */
  abortCherryPick(state: CherryPickConflict): CherryPickResult {
    try { this.run('git cherry-pick --abort'); } catch {}
    try { this.run(`git checkout "${state.originalBranch}"`); } catch {}
    return { status: 'error', targetBranch: state.targetBranch, pickedCount: 0, error: 'Cherry-pick aborted by user.' };
  }

  getConflictedFiles(): string[] {
    try {
      const out = this.run('git diff --name-only --diff-filter=U');
      if (!out) { return []; }
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
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

import { execSync } from 'child_process';

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
  commitMessage?: string;
  /** SHA the target branch was at before this cherry-pick session started, so Abort can fully revert it. */
  targetStartSha: string;
  /** True when conflict markers are resolved but the result is a no-op (fix already exists on target) — needs Skip or Commit Empty instead of a normal Continue. */
  emptyCommit?: boolean;
}

export type GitLogger = (message: string) => void;

export class GitService {
  public readonly repoPath: string;
  private readonly logger: GitLogger;

  constructor(repoPath: string, logger?: GitLogger) {
    this.repoPath = repoPath;
    this.logger = logger || (() => {});
  }

  private run(cmd: string): string {
    this.logger(`$ ${cmd}`);
    try {
      const out = execSync(cmd, {
        cwd: this.getRepoRoot(),
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
      if (out) { this.logger(out); }
      return out;
    } catch (err: any) {
      const message = err.stderr?.trim() || err.message;
      this.logger(`  ✗ ${message}`);
      throw new Error(message);
    }
  }

  private _repoRoot: string | undefined;

  /**
   * Absolute path to the git repository's top-level directory. This can differ
   * from `repoPath` (the VSCode workspace folder) when the workspace is opened
   * at a subdirectory of the repo. It matters for more than just opening files:
   * git commands that resolve pathspecs (e.g. `git add <path>`) do so relative
   * to the process's cwd, while `git diff`/`status` always REPORT paths
   * relative to the repo root — so every git invocation here must run from
   * the repo root, or a root-relative path like "packages/x" gets mangled
   * into "packages/packages/x" when cwd is already "packages".
   * Resolved directly via execSync (not through `run()`) to avoid recursion,
   * since `run()` itself uses this as its cwd.
   */
  getRepoRoot(): string {
    if (!this._repoRoot) {
      try {
        this._repoRoot = execSync('git rev-parse --show-toplevel', {
          cwd: this.repoPath,
          encoding: 'utf8',
        }).trim();
      } catch (err: any) {
        throw new Error(err.stderr?.trim() || err.message);
      }
    }
    return this._repoRoot;
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
   * Fast-forwards a local branch to match its remote counterpart before comparing.
   * If the branch is currently checked out, does a real `pull` so the working tree
   * stays in sync too. If it's a non-checked-out local branch, updates the branch
   * ref directly via a fetch refspec (fails harmlessly if not a fast-forward —
   * we never force-overwrite local commits). Falls back to a plain fetch so
   * remote-only branches still resolve correctly.
   */
  private syncBranchToRemote(branch: string, currentBranch: string): void {
    try {
      if (branch === currentBranch) {
        this.run(`git pull origin "${branch}" --ff-only --quiet`);
      } else {
        this.run(`git fetch origin "${branch}:${branch}" --quiet`);
      }
    } catch {
      try { this.run(`git fetch origin "${branch}" --quiet`); } catch {}
    }
  }

  /**
   * Returns commits that exist in sourceBranch but NOT in targetBranch.
   * These are the candidates for cherry-picking into target.
   */
  getCommitsBetween(sourceBranch: string, targetBranch: string): CommitInfo[] {
    // Make sure we have latest info from origin before comparing
    const currentBranch = this.getCurrentBranch();
    this.syncBranchToRemote(sourceBranch, currentBranch);
    this.syncBranchToRemote(targetBranch, currentBranch);

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
    push: boolean,
    commitMessage?: string
  ): Promise<CherryPickResult | CherryPickConflict> {
    const originalBranch = this.getCurrentBranch();

    try {
      try { this.run(`git fetch origin "${targetBranch}" --quiet`); } catch {}
      // Checkout the target branch directly
      this.run(`git checkout "${targetBranch}"`);
      // Pull latest to avoid conflicts with remote
      try { this.run(`git pull origin "${targetBranch}" --quiet`); } catch {}
      // Record where target started so Abort can fully revert this session's commits
      const targetStartSha = this.run('git rev-parse HEAD');

      return this._pickCommitsFrom(0, commits, targetBranch, originalBranch, push, 0, targetStartSha, commitMessage);
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
    pickedSoFar: number,
    targetStartSha: string,
    commitMessage?: string
  ): CherryPickResult | CherryPickConflict {
    for (let i = startIndex; i < allCommits.length; i++) {
      try {
        if (commitMessage) {
          this.run(`git cherry-pick --no-commit ${allCommits[i]}`);
          const escapedMsg = commitMessage.replace(/"/g, '\\"');
          this.run(`git commit -m "${escapedMsg}"`);
        } else {
          this.run(`git cherry-pick ${allCommits[i]}`);
        }
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
          commitMessage,
          targetStartSha,
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
   * Check if any file in the working tree still contains conflict markers.
   */
  hasConflictMarkers(): string[] {
    try {
      const out = this.run('git diff --name-only --diff-filter=U');
      if (!out) { return []; }
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Continue cherry-pick after user resolves conflicts.
   * Checks that all conflicts are actually resolved before proceeding.
   */
  continueCherryPick(state: CherryPickConflict): CherryPickResult | CherryPickConflict {
    // First check if conflicts are still present — don't auto-resolve anything
    const remaining = this.hasConflictMarkers();
    if (remaining.length > 0) {
      return { ...state, conflictedFiles: remaining };
    }

    try {
      // Only stage the files that were conflicted (user has resolved them)
      for (const f of state.conflictedFiles) {
        this.run(`git add -- "${f}"`);
      }

      if (state.commitMessage) {
        // CHERRY_PICK_HEAD is still set from the --no-commit pick, so a plain
        // commit here completes it (same mechanism git itself uses) — no abort needed.
        const escapedMsg = state.commitMessage.replace(/"/g, '\\"');
        this.run(`git commit -m "${escapedMsg}"`);
      } else {
        execSync('git cherry-pick --continue', {
          cwd: this.getRepoRoot(),
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, GIT_EDITOR: 'true' },
        });
      }

      return this._pickCommitsFrom(
        state.currentCommitIndex + 1,
        state.allCommits,
        state.targetBranch,
        state.originalBranch,
        state.push,
        state.pickedSoFar + 1,
        state.targetStartSha,
        state.commitMessage
      );
    } catch (err: any) {
      const message = err.stderr?.trim() || err.message;
      // Conflict resolution nets out to no actual change vs. target — git refuses
      // to auto-create an empty commit. Let the user explicitly choose instead of
      // getting stuck retrying the same failing continue.
      if (/previous cherry-pick is now empty/i.test(message) || /nothing to commit/i.test(message)) {
        return { ...state, conflictedFiles: [], emptyCommit: true };
      }
      const conflictedFiles = this.getConflictedFiles();
      if (conflictedFiles.length > 0) {
        return { ...state, conflictedFiles };
      }
      throw new Error(message);
    }
  }

  /**
   * Skip the current commit entirely — its change already exists on the target
   * branch (that's why resolving conflicts produced an empty diff), so there's
   * nothing to commit. Does not count towards pickedSoFar.
   */
  skipCurrentCommit(state: CherryPickConflict): CherryPickResult | CherryPickConflict {
    this.run('git cherry-pick --skip');
    return this._pickCommitsFrom(
      state.currentCommitIndex + 1,
      state.allCommits,
      state.targetBranch,
      state.originalBranch,
      state.push,
      state.pickedSoFar,
      state.targetStartSha,
      state.commitMessage
    );
  }

  /**
   * Force-commit the current pick as an empty commit, preserving a record of it
   * in history even though it introduced no changes.
   */
  commitCurrentAsEmpty(state: CherryPickConflict): CherryPickResult | CherryPickConflict {
    if (state.commitMessage) {
      const escapedMsg = state.commitMessage.replace(/"/g, '\\"');
      this.run(`git commit --allow-empty -m "${escapedMsg}"`);
    } else {
      this.run(`git commit --allow-empty -C ${state.currentCommitHash}`);
    }
    return this._pickCommitsFrom(
      state.currentCommitIndex + 1,
      state.allCommits,
      state.targetBranch,
      state.originalBranch,
      state.push,
      state.pickedSoFar + 1,
      state.targetStartSha,
      state.commitMessage
    );
  }

  /**
   * Abort cherry-pick, reset the target branch, and go back to original branch.
   * `--abort` alone only undoes the in-progress (conflicted) pick — any earlier
   * commits from this same batch that already succeeded would otherwise stay
   * committed, so we hard-reset the target branch back to where it was before
   * this cherry-pick session started.
   */
  abortCherryPick(state: CherryPickConflict): CherryPickResult {
    try { this.run('git cherry-pick --abort'); } catch {}
    try { this.run(`git reset --hard ${state.targetStartSha}`); } catch {}
    try { this.run(`git checkout "${state.originalBranch}"`); } catch {}
    return { status: 'error', targetBranch: state.targetBranch, pickedCount: 0, error: 'Cherry-pick aborted by user. Target branch reverted to its original state.' };
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

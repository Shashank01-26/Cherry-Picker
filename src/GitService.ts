import { execFileSync } from 'child_process';

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

  private displayCmd(args: string[]): string {
    return 'git ' + args.map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  }

  /**
   * Runs git with an argv array — never through a shell. This is the reason
   * branch names, commit messages, and file paths (all of which can contain
   * arbitrary characters, including shell metacharacters like `"`, `` ` ``,
   * `$()`, or `;`) can be passed through safely without any manual escaping:
   * each array element becomes exactly one argument to the `git` process,
   * with no shell interpretation in between.
   */
  private run(args: string[]): string {
    this.logger(`$ ${this.displayCmd(args)}`);
    try {
      const out = execFileSync('git', args, {
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
   * Resolved directly via execFileSync (not through `run()`) to avoid recursion,
   * since `run()` itself uses this as its cwd.
   */
  getRepoRoot(): string {
    if (!this._repoRoot) {
      try {
        this._repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
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
      this.run(['rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  }

  getCurrentBranch(): string {
    return this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  getLocalBranches(): string[] {
    const out = this.run(['branch', '--format=%(refname:short)']);
    return out.split('\n').map(b => b.trim()).filter(Boolean);
  }

  /**
   * Fetches the latest remote branch list from origin. Returns false (rather
   * than throwing) if the fetch fails — e.g. no network or bad credentials —
   * so callers can surface that the branch list may be stale instead of
   * silently pretending everything is up to date.
   */
  refreshRemotes(): boolean {
    try {
      this.run(['fetch', 'origin', '--prune', '--quiet']);
      return true;
    } catch {
      return false;
    }
  }

  getRemoteBranches(): string[] {
    try {
      const out = this.run(['branch', '-r', '--format=%(refname:short)']);
      return out
        .split('\n')
        .map(b => b.trim().replace(/^origin\//, ''))
        .filter(b => b && !b.startsWith('HEAD'));
    } catch {
      return [];
    }
  }

  /**
   * Full branch list (local + remote). Does NOT fetch on its own — call
   * `refreshRemotes()` first if you want origin's latest state reflected.
   */
  getAllBranches(): string[] {
    const local = this.getLocalBranches();
    const remote = this.getRemoteBranches();
    const all = new Set([...local, ...remote]);
    return Array.from(all).sort();
  }

  private localBranchExists(branch: string): boolean {
    try {
      this.run(['rev-parse', '--verify', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fast-forwards a branch to match its remote counterpart before comparing.
   * - If it's the currently checked-out branch, does a real `pull` so the
   *   working tree stays in sync too.
   * - If it's a different LOCAL branch, fast-forwards that branch's ref
   *   directly via a fetch refspec (fails harmlessly if not a fast-forward —
   *   we never force-overwrite local commits).
   * - If there's no local branch by this name at all, only its remote-tracking
   *   ref is updated — we deliberately avoid creating a new local branch as a
   *   side effect of just comparing branches.
   */
  private syncBranchToRemote(branch: string, currentBranch: string): void {
    try {
      if (branch === currentBranch) {
        this.run(['pull', 'origin', branch, '--ff-only', '--quiet']);
      } else if (this.localBranchExists(branch)) {
        this.run(['fetch', 'origin', `${branch}:${branch}`, '--quiet']);
      } else {
        this.run(['fetch', 'origin', branch, '--quiet']);
      }
    } catch {
      try { this.run(['fetch', 'origin', branch, '--quiet']); } catch {}
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
    const out = this.run(['log', sourceSha, `^${targetSha}`, `--format=${fmt}`, '--date=short', '--no-merges']);

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
      return this.run(['rev-parse', '--verify', `refs/heads/${branch}`]);
    } catch {}
    // Try remote tracking branch (refs/remotes/origin/...)
    try {
      return this.run(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
    } catch {}
    // Fallback: maybe it's already a SHA or tag
    try {
      return this.run(['rev-parse', '--verify', branch]);
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

  /** True if the working tree has any uncommitted changes (staged or not). */
  hasUncommittedChanges(): boolean {
    return this.run(['status', '--porcelain']).length > 0;
  }

  /**
   * True if the index currently differs from HEAD — i.e. committing right now
   * would produce a real commit. False means the resolved conflict nets out
   * to no actual change (the fix already exists on the target branch), so
   * committing would fail with git's "previous cherry-pick is now empty"
   * error. Checked proactively via `git diff --cached --quiet`'s exit code
   * rather than parsing that error message, which is locale-dependent and
   * would silently stop matching under a non-English git/OS locale.
   */
  private hasStagedChanges(): boolean {
    try {
      execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: this.getRepoRoot() });
      return false; // exit 0 — index matches HEAD
    } catch (err: any) {
      if (typeof err.status === 'number' && err.status === 1) {
        return true; // exit 1 — index differs from HEAD
      }
      throw new Error(err.stderr?.toString().trim() || err.message);
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

    if (this.hasUncommittedChanges()) {
      return {
        status: 'error',
        targetBranch,
        pickedCount: 0,
        error: `You have uncommitted changes on "${originalBranch}". Commit or stash them before cherry-picking, so they don't get carried onto "${targetBranch}".`,
      };
    }

    try {
      try { this.run(['fetch', 'origin', targetBranch, '--quiet']); } catch {}
      // Checkout the target branch directly
      this.run(['checkout', targetBranch]);
      // Pull latest to avoid conflicts with remote
      try { this.run(['pull', 'origin', targetBranch, '--quiet']); } catch {}
      // Record where target started so Abort can fully revert this session's commits
      const targetStartSha = this.run(['rev-parse', 'HEAD']);

      return this._pickCommitsFrom(0, commits, targetBranch, originalBranch, push, 0, targetStartSha, commitMessage);
    } catch (err: any) {
      try { this.run(['cherry-pick', '--abort']); } catch {}
      try { this.run(['checkout', originalBranch]); } catch {}
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
          this.run(['cherry-pick', '--no-commit', allCommits[i]]);
          this.run(['commit', '-m', commitMessage]);
        } else {
          this.run(['cherry-pick', allCommits[i]]);
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
      this.run(['push', 'origin', targetBranch]);
    }
    this.run(['checkout', originalBranch]);
    return { status: 'success', targetBranch, pickedCount: pickedSoFar };
  }

  /**
   * Check if any file in the working tree still contains conflict markers.
   */
  hasConflictMarkers(): string[] {
    try {
      const out = this.run(['diff', '--name-only', '--diff-filter=U']);
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
        this.run(['add', '--', f]);
      }

      // Resolving the conflict may have produced no actual change vs. target
      // (the fix already exists there) — detect that before attempting to
      // commit, since git refuses to auto-create an empty commit.
      if (!this.hasStagedChanges()) {
        return { ...state, conflictedFiles: [], emptyCommit: true };
      }

      if (state.commitMessage) {
        // CHERRY_PICK_HEAD is still set from the --no-commit pick, so a plain
        // commit here completes it (same mechanism git itself uses) — no abort needed.
        this.run(['commit', '-m', state.commitMessage]);
      } else {
        execFileSync('git', ['cherry-pick', '--continue'], {
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
    this.run(['cherry-pick', '--skip']);
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
      this.run(['commit', '--allow-empty', '-m', state.commitMessage]);
    } else {
      this.run(['commit', '--allow-empty', '-C', state.currentCommitHash]);
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
    try { this.run(['cherry-pick', '--abort']); } catch {}
    try { this.run(['reset', '--hard', state.targetStartSha]); } catch {}
    try { this.run(['checkout', state.originalBranch]); } catch {}
    return { status: 'error', targetBranch: state.targetBranch, pickedCount: 0, error: 'Cherry-pick aborted by user. Target branch reverted to its original state.' };
  }

  getConflictedFiles(): string[] {
    try {
      const out = this.run(['diff', '--name-only', '--diff-filter=U']);
      if (!out) { return []; }
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  getCommitFiles(hash: string): CommitFileChange[] {
    const out = this.run(['diff-tree', '--no-commit-id', '--name-status', '-r', hash]);
    if (!out) { return []; }
    return out.split('\n').map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { status: status.trim(), path: pathParts.join('\t').trim() };
    }).filter(f => f.path);
  }

  showFileAtCommit(ref: string, filePath: string): string {
    try {
      return this.run(['show', `${ref}:${filePath}`]);
    } catch {
      return '';
    }
  }

  getRepoName(): string {
    try {
      const remote = this.run(['remote', 'get-url', 'origin']);
      const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
      return match?.[1] ?? 'Unknown Repo';
    } catch {
      return 'Local Repo';
    }
  }
}

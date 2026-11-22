import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { UserError } from './errors.ts';
import {
  addWorktree, branchExists, branchName, currentBranchRef, deleteBranch, hasChanges, ignoredEntries, pruneWorktrees, reAddWorktree,
  removeWorktree, repoInfo, restoreWip, unstage, wipCommit, worktreeOn,
} from './git.ts';
import type { Workspace } from './store.ts';

export type WorktreeWs = Extract<Workspace, { mode: 'worktree' }>;

export function prepareWorkspace(o: { cwd: string; id: string; name: string; home: string; isolate: boolean }): {
  workspace: Workspace;
  launchCwd: string;
  warning?: string;
} {
  const inplace = (top?: string, warning?: string) => ({
    workspace: (top ? { mode: 'inplace', top } : { mode: 'inplace' }) as Workspace,
    launchCwd: o.cwd,
    ...(warning ? { warning } : {}),
  });
  const info = repoInfo(o.cwd);
  if (!info) return inplace();
  if (!o.isolate) return inplace(info.top);
  if (info.head === null) return inplace(info.top, 'This repo has no commits yet, so the session runs in the folder itself.');

  const root = join(o.home, 'worktrees');
  const worktree = join(root, o.id);
  let branch = '';
  let subdir = '';
  let added = false;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    branch = branchName(o.name, o.id);
    subdir = relative(info.top, realpathSync(o.cwd));
    addWorktree(info.top, worktree, branch, info.head);
    added = true;
    // the folder may be untracked/ignored/empty in HEAD: Claude must still start in the matching subfolder
    mkdirSync(join(worktree, subdir), { recursive: true });
  } catch (e) {
    // only undo what we made: a failed `worktree add` may be a collision with someone else's branch
    if (added) discardWorkspace({ mode: 'worktree', repo: info.top, commonDir: info.commonDir, worktree, branch, base: info.head, subdir, wip: null });
    throw new UserError(`Could not create the worktree: ${(e as Error).message}`);
  }
  const workspace: Workspace = {
    mode: 'worktree', repo: info.top, commonDir: info.commonDir, worktree, branch, base: info.head,
    subdir, wip: null,
  };
  return {
    workspace,
    launchCwd: launchCwdOf(o.cwd, workspace),
    ...(info.dirty ? { warning: `Uncommitted changes in ${basename(info.top)} aren't included in the worktree.` } : {}),
  };
}

export function launchCwdOf(cwd: string, ws: Workspace): string {
  return ws.mode === 'worktree' ? join(ws.worktree, ws.subdir) : cwd;
}

/** The folder briefing paths are relative to: the worktree, or the repo top of an in-place git session. */
export function briefingRoot(cwd: string, ws: Workspace): string {
  return ws.mode === 'worktree' ? ws.worktree : (ws.top ?? cwd);
}

/** Rollback of a worktree that never got used. Never throws. */
export function discardWorkspace(ws: Workspace): void {
  if (ws.mode !== 'worktree') return;
  try {
    removeWorktree(ws.repo, ws.worktree);
  } catch {
    // best effort
  }
  try {
    deleteBranch(ws.repo, ws.branch);
  } catch {
    // best effort
  }
}

/** Did Claude write a transcript for this id, under the given config folder (the session's account)? */
export function hasTranscript(claudeId: string, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): boolean {
  const projects = join(configDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return false;
  }
  return dirs.some((d) => existsSync(join(projects, d, `${claudeId}.jsonl`)));
}

// ---- pause / resume -------------------------------------------------------
// `git worktree remove` silently deletes gitignored files (.env, node_modules), so pause moves
// them into <home>/paused/<id>/ first. Nothing here ever overwrites or deletes a user file.

const present = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

class Clash extends Error {}

/** Move `rel` from one root to another, refusing to replace anything already at the target. */
function move(fromRoot: string, toRoot: string, rel: string, dirMode?: number): void {
  const to = join(toRoot, rel);
  if (present(to)) throw new Clash(`${to} already exists`);
  mkdirSync(dirname(to), { recursive: true, mode: dirMode });
  renameSync(join(fromRoot, rel), to);
}

/** Remove `dir` and its empty subfolders; anything still holding a file is kept. */
function pruneEmpty(dir: string): void {
  let entries: string[];
  try {
    if (!lstatSync(dir).isDirectory()) return;
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) pruneEmpty(join(dir, e));
  try {
    rmdirSync(dir);
  } catch {
    // not empty: something was left behind on purpose
  }
}

/** Put everything under `stash` back into `wt`, merging into existing folders; a clash stays in the stash. */
function restoreStash(stash: string, wt: string, rel = ''): void {
  let entries: string[];
  try {
    entries = readdirSync(join(stash, rel));
  } catch {
    return;
  }
  for (const name of entries) {
    const r = rel === '' ? name : join(rel, name);
    const target = join(wt, r);
    if (!present(target)) {
      try {
        move(stash, wt, r);
      } catch {
        // left in the stash: never lost
      }
    } else if (lstatSync(target).isDirectory() && lstatSync(join(stash, r)).isDirectory()) {
      restoreStash(stash, wt, r);
    }
  }
}

function undoPause(ws: WorktreeWs, stash: string, moved: string[], sha: string | null): void {
  for (const rel of [...moved].reverse()) {
    try {
      move(stash, ws.worktree, rel);
    } catch {
      // left in the stash: never lost
    }
  }
  pruneEmpty(stash);
  try {
    if (sha !== null) restoreWip(ws.worktree, sha);
  } catch {
    // the WIP commit stays on the branch: nothing is lost
  }
}

/** `afterMove` is a test seam: it runs after the ignored files are set aside, before the re-check. */
/** Refusals that need no git write; run before stopping Claude so a refused pause leaves it running. */
export function checkPausable(ws: WorktreeWs): void {
  if (!existsSync(ws.worktree)) throw new UserError('The worktree folder is gone. Resume recreates it from the branch, or Archive the session.');
  // a WIP commit must only ever land on the session's own tend/ branch
  const ref = currentBranchRef(ws.worktree);
  if (ref !== `refs/heads/${ws.branch}`) {
    const on = ref === null ? 'a detached HEAD' : ref.replace(/^refs\/heads\//, '');
    throw new UserError(`The worktree is on ${on}, not ${ws.branch}. Switch back before pausing.`);
  }
}

export function pauseWorkspace(ws: WorktreeWs, stash: string, seam: { afterMove?: () => void } = {}): WorktreeWs {
  const wt = ws.worktree;
  checkPausable(ws); // again after Claude stopped: it may have switched branches in the meantime
  let sha: string | null;
  try {
    sha = wipCommit(wt);
  } catch (e) {
    try {
      unstage(wt);
    } catch {
      // nothing was committed; the files themselves are untouched
    }
    throw new UserError(`Could not save work in progress: ${message(e)}`);
  }
  const moved: string[] = [];
  try {
    const root = dirname(stash);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    mkdirSync(stash, { recursive: true, mode: 0o700 });
    for (const rel of ignoredEntries(wt)) {
      move(wt, stash, rel, 0o700);
      moved.push(rel);
    }
  } catch (e) {
    undoPause(ws, stash, moved, sha);
    const why = e instanceof Clash ? `${stash} still holds files from an earlier pause` : message(e);
    throw new UserError(`Could not set aside ignored files: ${why}`);
  }
  seam.afterMove?.();
  // `worktree remove` would silently delete anything written since: a process still running there aborts the pause
  let busy: boolean;
  try {
    busy = ignoredEntries(wt).length > 0 || hasChanges(wt);
  } catch {
    busy = true;
  }
  if (busy) {
    undoPause(ws, stash, moved, sha);
    throw new UserError('Something is still writing in the worktree (a dev server?). Stop it and pause again.');
  }
  try {
    removeWorktree(ws.repo, wt);
  } catch (e) {
    undoPause(ws, stash, moved, sha);
    throw new UserError(`Could not remove the worktree: ${message(e)}`);
  }
  return { ...ws, wip: sha };
}

export function resumeWorkspace(ws: WorktreeWs, stash: string): { workspace: WorktreeWs; warning?: string } {
  // a worktree folder deleted by hand still counts as checked out until pruned; prune (repo-wide) only then
  if (!existsSync(ws.worktree) && worktreeOn(ws.repo, ws.worktree, ws.branch)) {
    try {
      pruneWorktrees(ws.repo);
    } catch {
      // best effort: the re-add below reports a real problem
    }
  }
  if (!worktreeOn(ws.repo, ws.worktree, ws.branch)) {
    if (!branchExists(ws.repo, ws.branch)) throw new UserError(`Branch ${ws.branch} no longer exists.`);
    try {
      reAddWorktree(ws.repo, ws.worktree, ws.branch);
    } catch (e) {
      throw new UserError(`Could not create the worktree: ${message(e)}`);
    }
  }
  let warning: string | undefined;
  if (ws.wip !== null) {
    let restored: boolean;
    try {
      restored = restoreWip(ws.worktree, ws.wip);
    } catch (e) {
      throw new UserError(`Could not restore work in progress: ${message(e)}`);
    }
    if (!restored) warning = `The paused work is in commit ${ws.wip.slice(0, 7)} but the branch has moved; restore it by hand if needed.`;
  }
  restoreStash(stash, ws.worktree);
  pruneEmpty(stash);
  return { workspace: { ...ws, wip: null }, ...(warning ? { warning } : {}) };
}

/** True when a resume left files in the stash (they clashed with files already in the worktree). */
export function stashKept(stash: string): boolean {
  return present(stash);
}

/** Archive frees the worktree like pause; an already-paused one keeps its stash and WIP commit. */
export function archiveWorkspace(ws: Workspace, paused: boolean, stash: string): void {
  if (ws.mode !== 'worktree' || paused) return;
  // a worktree folder deleted by hand has nothing left to save; let git forget it so the branch is free
  if (!existsSync(ws.worktree)) {
    try {
      if (worktreeOn(ws.repo, ws.worktree, ws.branch)) pruneWorktrees(ws.repo);
    } catch {
      // best effort: the next resume prunes too
    }
    return;
  }
  pauseWorkspace(ws, stash);
}

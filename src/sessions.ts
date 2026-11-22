import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { isClaudeId, normalize } from './events.ts';
import type { TendEvent } from './events.ts';
import { initialState, notifyFor, reduce } from './state.ts';
import type { NotifyIntent, SessionState } from './state.ts';
import type { SessionRow, Store, Workspace } from './store.ts';
import type { Tmux } from './tmux.ts';
import { claudeBin, forAccount as wrapFor, launchArgv, launchEnv as envFor, writeLaunchFiles } from './claude-launch.ts';
import { defaultAccountDir, HOME_CLAUDE, listAccounts } from './accounts.ts';
import type { Account } from './accounts.ts';
import { createUsageTracker } from './usage-tracker.ts';
import type { AccountUsage } from './usage-tracker.ts';
import type { ContextView } from './usage.ts';
import { createStatusSink } from './session-status.ts';
import { createFlags } from './flags.ts';
import { createPaneSync } from './pane-sync.ts';
import { attach, attachmentDir, safeAttachmentDir } from './attachments.ts';
import type { Saved } from './attachments.ts';
import { cleanName, expandHome, isDir, isSessionId, tmuxName } from './session-util.ts';
import type { Stuck } from './stuck.ts';
import type { Intent } from './attention.ts';
import { UserError } from './errors.ts';
import { buildBriefing } from './briefing.ts';
import type { Briefing } from './briefing.ts';
import type { GitFacts } from './git.ts';
import { createTrustCheck } from './trust.ts';
import { createBroker } from './decisions.ts';
import type { Answer, DecisionView, Held } from './decisions.ts';
import { cachedRules } from './risk.ts';
import { createGitWatch } from './git-watch.ts';
import type { WatchTarget } from './git-watch.ts';
import type { Overlap } from './overlap.ts';
import {
  archiveWorkspace, briefingRoot, checkPausable, discardWorkspace, hasTranscript, launchCwdOf, pauseWorkspace, prepareWorkspace, resumeWorkspace,
  stashKept,
} from './workspace.ts';

const workspaceView = (w: Workspace): WorkspaceView =>
  w.mode === 'worktree' ? { mode: 'worktree', branch: w.branch, worktree: w.worktree } : { mode: 'inplace' };

export { UserError };
export type { Registry, SessionView, WorkspaceView } from './session-types.ts';
import type { Registry, SessionView, WorkspaceView } from './session-types.ts';

export { expandHome, isSessionId, SESSION_ID, tmuxName } from './session-util.ts';

const KILL_WAIT_MS = 3000;
const KILL_POLL_MS = 100;
const COLS = 160;
const ROWS = 45;

export function createRegistry(deps: {
  store: Store;
  tmux: Tmux;
  home: string;
  port: number;
  /** The hook token written into each session's settings (never the UI token). */
  token: string;
  notify: (i: Intent) => void;
  now?: () => number;
  /** How long pause/archive wait for a killed tmux session to go (default 3 s). */
  killWaitMs?: number;
}): Registry {
  const now = deps.now ?? Date.now;
  // worktrees live under the real path of home (tmpdir() on macOS is a symlink)
  const home = realpathSync(deps.home);
  const views = new Map<string, SessionView>();
  const listeners = new Set<(v: SessionView) => void>();
  const broker = createBroker({
    rules: () => cachedRules(join(home, 'risk-rules.json')),
    now,
    onChange: (id) => {
      const view = views.get(id);
      if (!view) return;
      const ds = broker.pendingFor(id);
      if (ds.length) view.decisions = ds;
      else delete view.decisions;
      emit(view);
    },
  });

  // Known sessions survive a server restart; reconcile() rebuilds their state from stored events.
  for (const r of deps.store.listSessions()) {
    if (r.archived) continue;
    const state: SessionState = r.endedAt === null ? initialState(r.createdAt) : { status: 'ended', since: r.endedAt };
    const v: SessionView = { id: r.id, name: r.name, cwd: r.cwd, state, createdAt: r.createdAt, workspace: workspaceView(r.workspace), paused: r.paused, account: r.account || defaultAccountDir() };
    if (!r.account) deps.store.updateSession(r.id, { account: v.account }); // pin rows from before v0.4
    try {
      if (r.context) v.context = JSON.parse(r.context) as ContextView;
    } catch {
      // a broken saved context is just forgotten
    }
    views.set(r.id, v);
  }

  const watchTargets = (): WatchTarget[] =>
    [...views.values()].map((v) => {
      const row = deps.store.getSession(v.id);
      const ws = row?.workspace;
      return {
        id: v.id,
        name: v.name,
        dir: row && ws ? launchCwdOf(row.cwd, ws) : v.cwd,
        base: ws?.mode === 'worktree' ? ws.base : null,
        commonDir: ws?.mode === 'worktree' ? ws.commonDir : null,
        eligible: !v.paused && row !== undefined && !row.archived,
      };
    });

  const gitWatch = createGitWatch({
    targets: watchTargets,
    notify: deps.notify,
    set(id, git, overlap) {
      const view = views.get(id);
      if (!view) return;
      if (JSON.stringify(view.git) === JSON.stringify(git) && JSON.stringify(view.overlap) === JSON.stringify(overlap)) return;
      if (git) view.git = git;
      else delete view.git;
      if (overlap) view.overlap = overlap;
      else delete view.overlap;
      emit(view);
    },
  });
  const refreshSoon = (): void => {
    gitWatch.refresh().catch(() => undefined);
  };
  const GIT_TRIGGERS = new Set(['PostToolUse', 'Stop', 'UserPromptSubmit']);

  const paneGone = (id: string): boolean => !deps.tmux.has(tmuxName(id)) || deps.tmux.paneDead(tmuxName(id));

  const emit = (v: SessionView): void => {
    for (const fn of listeners) {
      try {
        fn(v);
      } catch {
        // a broken listener must not break ingest
      }
    }
  };

  const flags = createFlags({ notify: (i) => deps.notify(i), emit: (v) => emit(v as SessionView), now });

  const apply = (view: SessionView, ev: TendEvent): void => {
    deps.store.appendEvent(ev);
    const prev = view.state;
    let next = reduce(prev, ev);
    // a held request still waiting keeps the session in needs-you, whatever else happened meanwhile
    const waiting = next.status !== 'ended' && next.status !== 'needs_you' ? broker.pendingFor(view.id)[0] : undefined;
    if (waiting) next = { status: 'needs_you', need: waiting.kind, since: prev.status === 'needs_you' ? prev.since : ev.ts, ...(next.lastTool ? { lastTool: next.lastTool } : {}) };
    const flagged = flags.onEvent(view, prev, ev);
    if (next === prev || (next.status === prev.status && next.need === prev.need && next.since === prev.since && next.lastTool === prev.lastTool)) {
      if (flagged) emit(view);
      return;
    }
    view.state = next;
    if (next.status === 'ended' && prev.status !== 'ended') {
      deps.store.markEnded(view.id, ev.ts);
      broker.drop(view.id); // their requests ended with Claude
      forgetUsage(view.id);
    }
    const intent = notifyFor(prev, next, view.id, view.name);
    // a high-risk permission interrupts even inside a focus window
    if (intent) deps.notify({ ...intent, kind: 'need', urgent: next.need === 'permission' && broker.pendingFor(view.id).some((d) => d.risk?.level === 'high') });
    emit(view);
  };

  /** A hook event from the session's live launch, or why not. */
  const check = (sessionId: string, body: unknown, launch: string | undefined): 'unknown' | 'dropped' | TendEvent => {
    if (!isSessionId(sessionId)) return 'unknown';
    const view = views.get(sessionId);
    if (!view) return 'unknown';
    const row = deps.store.getSession(sessionId);
    // a stale hook from an earlier launch is dropped; v0.1 rows (no nonce) accept everything
    if (row && row.launch !== '' && row.launch !== launch) return 'dropped';
    return normalize(body, sessionId, now()) ?? 'dropped';
  };

  /** Record a hook event if it's from the session's live launch. */
  const accept = (sessionId: string, body: unknown, launch: string | undefined, checked = check(sessionId, body, launch)): 'unknown' | 'dropped' | 'applied' => {
    if (typeof checked === 'string') return checked;
    const ev = checked;
    const view = views.get(sessionId)!;
    const row = deps.store.getSession(sessionId);
    if (row && ev.claudeSessionId !== undefined && ev.claudeSessionId !== row.claudeId) {
      deps.store.updateSession(sessionId, { claudeId: ev.claudeSessionId });
    }
    // a request answered in the terminal stays open in 2.1.312: the hooks that follow settle its card, before
    // the state is worked out (a settled card must not keep the session in needs-you)
    if (ev.kind === 'Stop' || ev.kind === 'UserPromptSubmit') broker.settle(sessionId);
    else if ((ev.kind === 'PostToolUse' || ev.kind === 'PostToolUseFailure') && ev.tool !== undefined) {
      broker.settle(sessionId, { tool: ev.tool, input: (body as { tool_input?: unknown }).tool_input });
    }
    apply(view, ev);
    if (GIT_TRIGGERS.has(ev.kind)) gitWatch.schedule(sessionId);
    return 'applied';
  };

  const checkTrust = createTrustCheck({
    views: () => views.values(),
    snapshot: (id) => deps.tmux.snapshot(tmuxName(id)),
    apply,
    now,
  });
  const paneSync = createPaneSync({
    views: () => views.values(),
    snapshot: (id) => deps.tmux.snapshot(tmuxName(id)),
    hasCard: (id) => broker.pendingFor(id).length > 0,
    lastActivity: (id) => flags.lastActivity(id),
    apply: (v, ev) => apply(v as SessionView, ev),
    now,
  });

  const accountOf = (id: string): string => views.get(id)?.account ?? defaultAccountDir();
  const launchEnv = (id: string, account = accountOf(id)): Record<string, string> => envFor(id, account, HOME_CLAUDE());
  const forAccount = (argv: string[], account: string): string[] => wrapFor(argv, account, HOME_CLAUDE());
  const tracker = createUsageTracker({
    store: deps.store,
    notify: deps.notify,
    now,
    accounts: listAccounts,
    sessions: () => new Map([...views.values()].filter((v) => v.state.status !== 'ended').map((v) => [v.id, { name: v.name, account: v.account }])),
  });
  const statusSink = createStatusSink({
    store: deps.store,
    tracker,
    view: (id) => views.get(id),
    emit: (id) => {
      const v = views.get(id);
      if (v) emit(v);
    },
  });
  const forgetUsage = (id: string): void => statusSink.forget(id);
  const forgetAll = (id: string): void => (forgetUsage(id), flags.forget(id));

  const stashOf = (id: string): string => join(home, 'paused', id);
  /** In-place attachments live under Tend's home: Claude gets --add-dir for them. */
  const addDirs = (id: string, ws: Workspace): string[] => {
    if (ws.mode !== 'inplace') return [];
    const dir = attachmentDir(home, id, ws);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return [dir];
  };
  const writeLaunchSettings = (id: string, launch: string): string =>
    writeLaunchFiles(deps.home, { port: deps.port, token: deps.token, sessionId: id, launch });

  const lookup = (id: string): { view: SessionView; row: SessionRow } => {
    const view = views.get(id);
    const row = deps.store.getSession(id);
    // archived while queued behind an archive: the route gate let it through, so answer like a missing session
    if (!view || !row || row.archived) throw new UserError('Session not found.');
    return { view, row };
  };

  const paneExit = (view: SessionView): void => apply(view, { ts: now(), sessionId: view.id, kind: 'pane_exit', data: null });

  /** Kill the tmux session, wait (up to 3 s) for it to go, and record the end. Git is never touched while claude may still run. */
  const killAndWait = async (view: SessionView): Promise<void> => {
    const name = tmuxName(view.id);
    flags.stopping.add(view.id); // Tend stops it: not a crash
    try {
      deps.tmux.kill(name);
      const end = Date.now() + (deps.killWaitMs ?? KILL_WAIT_MS);
      while (deps.tmux.has(name) && Date.now() < end) await new Promise((r) => setTimeout(r, KILL_POLL_MS));
      if (deps.tmux.has(name)) throw new UserError('The session did not stop. Try again.');
      if (view.state.status !== 'ended') paneExit(view);
    } finally {
      flags.stopping.delete(view.id);
    }
  };

  // pause/resume/archive of one session never interleave
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return run;
  };

  const newId = (): string => {
    for (;;) {
      const id = randomBytes(4).toString('hex');
      if (!views.has(id) && !deps.store.getSession(id)) return id;
    }
  };

  const registry: Registry = {
    create(o) {
      const cwd = resolve(expandHome(o.cwd));
      if (!isDir(cwd)) throw new UserError(`Folder not found: ${o.cwd}`);
      // the account last used for this folder, else the default; "roomiest" only when asked for
      const accounts = listAccounts();
      const lastHere = deps.store.listSessions().find((r) => r.cwd === cwd && r.account && accounts.some((a) => a.dir === r.account))?.account;
      let account = lastHere ?? defaultAccountDir();
      if (o.account === 'roomiest') account = tracker.roomiest() ?? account;
      else if (o.account !== undefined) {
        const a = accounts.find((x) => x.dir === resolve(expandHome(o.account!)));
        if (!a) throw new UserError(`Unknown account: ${o.account}`);
        account = a.dir;
      }

      const id = newId();
      const name = cleanName(o.name, cwd);
      const createdAt = now();
      const claudeId = o.resume ?? randomUUID();
      const launch = randomBytes(8).toString('hex');
      const { workspace, launchCwd, warning } = prepareWorkspace({ cwd, id, name, home, isolate: o.resume === undefined && (o.isolate ?? true) });
      let settingsPath: string | undefined;
      try {
        settingsPath = writeLaunchSettings(id, launch);
        // record first: a store failure must never leave an untracked claude running in tmux
        deps.store.addSession({
          id, name, cwd, createdAt, endedAt: null, claudeId, launch,
          workspace, paused: false, archived: false, account, context: '',
        });
      } catch (e) {
        discardWorkspace(workspace);
        if (settingsPath !== undefined) rmSync(dirname(settingsPath), { recursive: true, force: true });
        throw e;
      }
      try {
        deps.tmux.newSession(tmuxName(id), launchCwd, forAccount(launchArgv(claudeBin(), settingsPath!, name, { id: claudeId, resume: o.resume !== undefined }, addDirs(id, workspace)), account), COLS, ROWS, launchEnv(id, account));
      } catch (e) {
        deps.store.markEnded(id, now());
        rmSync(dirname(settingsPath!), { recursive: true, force: true });
        discardWorkspace(workspace);
        deps.store.updateSession(id, { workspace: { mode: 'inplace' }, archived: true });
        throw e;
      }
      const view: SessionView = { id, name, cwd, state: initialState(createdAt), createdAt, workspace: workspaceView(workspace), paused: false, account };
      views.set(id, view);
      emit(view);
      refreshSoon();
      return warning ? { ...view, warning } : view;
    },

    list() {
      return [...views.values()].sort((a, b) => b.createdAt - a.createdAt);
    },

    get(id) {
      return views.get(id);
    },

    ingest(sessionId, body, launch) {
      return accept(sessionId, body, launch) !== 'unknown';
    },

    hold(sessionId, body, launch, held) {
      const ev = check(sessionId, body, launch);
      if (typeof ev === 'string') return null;
      const row = deps.store.getSession(sessionId)!;
      // the card exists before the state flips, so the UI never flashes "waiting in the terminal"
      const view = views.get(sessionId)!;
      const before = view.state;
      const did = broker.hold(sessionId, body as Record<string, unknown>, briefingRoot(row.cwd, row.workspace), held);
      accept(sessionId, body, launch, ev);
      // a high-risk request behind another card makes no state change, so apply sends nothing: say it here
      const d = did ? broker.pendingFor(sessionId).find((x) => x.id === did) : undefined;
      // (only when the state didn't change: a change already notified, urgently, from apply)
      const unchanged = before.status === 'needs_you' && view.state.status === 'needs_you' && view.state.need === before.need;
      if (unchanged && d?.risk?.level === 'high') deps.notify({ sessionId, title: view.name, body: `High-risk request: ${d.risk.rule}`, urgent: true, kind: 'need' });
      return did;
    },

    status(sessionId, body, launch) {
      if (!isSessionId(sessionId)) return false;
      const view = views.get(sessionId);
      const row = view && deps.store.getSession(sessionId);
      if (!view || !row || view.state.status === 'ended' || (row.launch !== '' && row.launch !== launch)) return false;
      const before = view.context?.tokens;
      statusSink.ingest(view, body);
      if (view.context && before !== undefined && view.context.tokens !== before) flags.alive(sessionId, view.context.at);
      return true;
    },

    usage() {
      return tracker.list();
    },

    attach(id, name, data) {
      const { view, row } = lookup(id);
      if (row.paused || view.state.status === 'ended') throw new UserError('Resume the session first, then attach.');
      return attach({ home, id, ws: row.workspace, launchCwd: launchCwdOf(row.cwd, row.workspace), name, data });
    },

    attachments(id) {
      return safeAttachmentDir(home, id, lookup(id).row.workspace, false); // read-only: never creates folders
    },

    diffBase(id) {
      const ws = lookup(id).row.workspace;
      return ws.mode === 'worktree' ? ws.base : null;
    },

    repoTop(id) {
      const ws = lookup(id).row.workspace;
      return ws.mode === 'inplace' ? (ws.top ?? null) : null;
    },

    accounts() {
      return listAccounts();
    },

    decisionClosed(decisionId) {
      broker.closed(decisionId);
    },

    answer(sessionId, decisionId, a) {
      const view = views.get(sessionId);
      if (!view) throw new UserError('Unknown session');
      broker.answer(sessionId, decisionId, a);
      // answered from Tend: Claude carries on; its next hooks settle the state (another card keeps needs-you)
      apply(view, { ts: now(), sessionId, kind: 'decided', data: { decision: decisionId, action: a.action } });
      return view;
    },

    reconcile(at) {
      for (const r of deps.store.listSessions()) {
        const view = views.get(r.id);
        if (!view) continue;
        // fold the stored events (no notify on replay); a recorded end always wins
        let state = initialState(r.createdAt);
        const evs = deps.store.eventsFor(r.id);
        for (const ev of evs) state = reduce(state, ev);
        if (r.endedAt !== null) state = { status: 'ended', since: r.endedAt };
        else if (state.status !== 'ended' && paneGone(r.id)) state = { status: 'ended', since: at };
        if (state.status === 'ended' && r.endedAt === null) deps.store.markEnded(r.id, state.since);
        view.state = state;
        flags.replay(view, evs);
      }
    },

    checkPanes() {
      for (const view of views.values()) {
        if (view.state.status === 'ended' || !paneGone(view.id)) continue;
        paneExit(view);
      }
      flags.tick(views.values(), now());
    },

    pause(id) {
      return serial(id, async () => {
        const { view, row } = lookup(id);
        if (row.workspace.mode !== 'worktree') throw new UserError('Pause needs a session with its own worktree.');
        if (row.paused) return view;
        checkPausable(row.workspace);
        await killAndWait(view);
        const workspace = pauseWorkspace(row.workspace, stashOf(id));
        deps.store.updateSession(id, { workspace, paused: true });
        view.paused = true;
        emit(view);
        refreshSoon();
        return view;
      });
    },

    resume(id) {
      return serial(id, async () => {
        const { view, row } = lookup(id);
        if (!row.paused && !paneGone(id)) throw new UserError('Session is still running.');
        if (row.workspace.mode === 'inplace' && !isDir(row.cwd)) throw new UserError(`Folder not found: ${row.cwd}`);
        let workspace = row.workspace;
        const warnings: string[] = [];
        // a missing worktree on an unpaused row is a pause that crashed before it was recorded
        if (workspace.mode === 'worktree' && (row.paused || !existsSync(workspace.worktree))) {
          const stash = stashOf(id);
          const resumed = resumeWorkspace(workspace, stash);
          workspace = resumed.workspace;
          deps.store.updateSession(id, { workspace, paused: false });
          view.paused = false;
          view.workspace = workspaceView(workspace);
          if (resumed.warning) warnings.push(resumed.warning);
          if (stashKept(stash)) warnings.push(`Some ignored files were kept in ${stash} because the worktree already has them.`);
        }
        const launchCwd = launchCwdOf(row.cwd, workspace);
        // the start folder may be untracked (or empty) and so not come back with the worktree
        if (workspace.mode === 'worktree') mkdirSync(launchCwd, { recursive: true });
        deps.tmux.kill(tmuxName(id)); // clear a dead pane
        let claudeId = row.claudeId;
        if (claudeId === '') {
          // a v0.1 row: Claude's own id is only known from its hooks
          const evs = deps.store.eventsFor(id);
          for (let i = evs.length - 1; i >= 0 && claudeId === ''; i--) {
            const c = evs[i]!.claudeSessionId;
            if (isClaudeId(c)) claudeId = c;
          }
        }
        // never hand claude (or a transcript path) an id that is not a UUID
        if (!isClaudeId(claudeId)) claudeId = randomUUID();
        const account = accountOf(id);
        if (!isDir(account)) throw new UserError(`Its account folder ${account} is gone: Claude would start logged out.`);
        const resume = hasTranscript(claudeId, account);
        if (!resume && deps.store.eventsFor(id).some((e) => e.kind === 'UserPromptSubmit')) {
          warnings.push("Claude's earlier conversation wasn't found, so this starts a new one (the briefing keeps what happened).");
        }
        const launch = randomBytes(8).toString('hex');
        const settingsPath = writeLaunchSettings(id, launch);
        // endedAt is cleared before the resumed event, so a restart never sees a stale end
        deps.store.updateSession(id, { claudeId, launch, endedAt: null });
        delete view.context; // the resumed launch reports its own
        deps.store.updateSession(id, { context: '' });
        forgetUsage(id);
        apply(view, { ts: now(), sessionId: id, kind: 'resumed', data: null });
        try {
          deps.tmux.newSession(
            tmuxName(id), launchCwd, forAccount(launchArgv(claudeBin(), settingsPath, view.name, { id: claudeId, resume }, addDirs(id, row.workspace)), accountOf(id)),
            COLS, ROWS, launchEnv(id),
          );
        } catch (e) {
          flags.stopping.add(id); // the user sees this error; it isn't a crash
          paneExit(view);
          flags.stopping.delete(id);
          throw e;
        }
        refreshSoon();
        return warnings.length > 0 ? { ...view, warning: warnings.join(' ') } : view;
      });
    },

    archive(id) {
      return serial(id, async () => {
        const { view, row } = lookup(id);
        const ws = row.workspace;
        if (ws.mode === 'worktree' && !row.paused && existsSync(ws.worktree)) checkPausable(ws);
        await killAndWait(view);
        archiveWorkspace(row.workspace, row.paused, stashOf(id));
        if (row.workspace.mode === 'inplace') rmSync(attachmentDir(home, id, row.workspace), { recursive: true, force: true }); // Tend's copy
        deps.store.updateSession(id, { archived: true });
        broker.drop(id);
        forgetAll(id);
        views.delete(id);
        const { git: _git, overlap: _overlap, decisions: _decisions, stuck: _stuck, crashed: _crashed, ...rest } = view;
        emit({ ...rest, archived: true });
        refreshSoon();
      });
    },

    checkTrust() {
      checkTrust();
      paneSync(); // states lost while Tend was down come back from the screen
    },

    briefing(id) {
      const { view, row } = lookup(id);
      return { ...buildBriefing(deps.store.eventsFor(id), briefingRoot(row.cwd, row.workspace)), state: view.state };
    },

    refreshGit(opts) {
      return gitWatch.refresh(opts);
    },

    close() {
      gitWatch.close();
      tracker.flush();
      statusSink.close(views.values());
    },

    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return registry;
}

// "Elsewhere": Claude sessions started outside tend. Listing is read-only; Adopt resumes a closed one under tend.
import type { Ctx } from './server.ts';
import { HttpError, readJson, send } from './http.ts';
import { adoptBlocker, isClaudeSessionId } from './external.ts';
import { hasTranscript } from './workspace.ts';

type Handler = (c: Ctx) => void | Promise<void>;

export const listExternal: Handler = async ({ req, res, external }) => {
  req.resume();
  send(res, 200, await external.list());
};

let adopting = false;

export const adopt: Handler = async ({ req, res, external, reg, store }) => {
  const body = (await readJson(req, 4096)) as { sessionId?: unknown } | null;
  const sid = body?.sessionId;
  if (!isClaudeSessionId(sid)) throw new HttpError(400, 'sessionId must be a Claude session id');
  if (adopting) throw new HttpError(409, 'Another adopt is under way; try again in a moment.');
  adopting = true;
  try {
    const rows = await external.list(true); // never adopt on a stale look: it may have been reopened since
    if (store.listSessions().some((r) => r.claudeId === sid)) throw new HttpError(409, 'Tend already runs that session.');
    const r = rows.find((x) => x.sessionId === sid);
    const why = adoptBlocker(r, hasTranscript);
    if (why) throw new HttpError(409, why);
    send(res, 201, reg.create({ cwd: r!.cwd, name: r!.name, isolate: false, account: r!.account, resume: sid }));
  } finally {
    adopting = false;
  }
};

import { timingSafeEqual } from 'node:crypto';

export type AuthResult = { ok: true; setCookie?: string } | { ok: false; status: 401 | 403 };

type Req = { headers: Record<string, string | string[] | undefined>; url: string };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function authorize(req: Req, token: string, port: number): AuthResult {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = first(req.headers.origin);
  if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return { ok: false, status: 403 };
  const host = first(req.headers.host);
  if (host === undefined || !hosts.includes(host)) return { ok: false, status: 403 };

  const headerToken = first(req.headers['x-tend-token']);
  if (headerToken !== undefined && safeEqual(headerToken, token)) return { ok: true };

  const cookie = cookieValue(first(req.headers.cookie), 'tend_token');
  if (cookie !== undefined && safeEqual(cookie, token)) return { ok: true };

  let key: string | null = null;
  try {
    key = new URL(req.url, 'http://localhost').searchParams.get('key');
  } catch {
    key = null;
  }
  if (key !== null && safeEqual(key, token)) {
    return { ok: true, setCookie: `tend_token=${token}; HttpOnly; SameSite=Strict; Path=/` };
  }
  return { ok: false, status: 401 };
}

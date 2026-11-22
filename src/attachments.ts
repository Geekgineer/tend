import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import type { Workspace } from './store.ts';
import { randomBytes } from 'node:crypto';
import { UserError } from './errors.ts';

// Screenshots, images, PDFs and files into a session (spec §6.1): every media item becomes a file plus a path
// that Claude reads. Nothing leaves the machine.

export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_EDGE = 2000;

export type Kind = 'png' | 'jpeg' | 'gif' | 'webp' | 'heic' | 'tiff' | 'pdf' | 'video' | 'file';

/** The file type from its bytes, never its name. */
export function sniff(b: Buffer): Kind {
  const at = (i: number, s: string): boolean => b.subarray(i, i + s.length).toString('latin1') === s;
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG')) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (at(0, 'GIF8')) return 'gif';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  if (at(0, 'II*\0') || at(0, 'MM\0*')) return 'tiff';
  if (at(0, '%PDF')) return 'pdf';
  if (at(4, 'ftyp')) {
    const brand = b.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(brand)) return 'heic';
    if (/^(isom|iso2|mp41|mp42|avc1|M4V |qt  |3gp)/.test(brand)) return 'video';
  }
  if (at(0, '\x1aE\xdf\xa3')) return 'video'; // webm / mkv
  return 'file';
}

/** JPEG without APP1 (EXIF, XMP) and APP13 (IPTC) segments: no GPS, camera or author data. */
export function stripJpeg(b: Buffer): Buffer {
  if (!(b[0] === 0xff && b[1] === 0xd8)) return b;
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // start of scan: the rest is image data
    const len = b.readUInt16BE(i + 2);
    const seg = b.subarray(i, i + 2 + len);
    if (marker !== 0xe1 && marker !== 0xed) parts.push(seg);
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  return Buffer.concat(parts);
}

/** PNG without text and EXIF chunks (tEXt, zTXt, iTXt, eXIf, tIME). */
export function stripPng(b: Buffer): Buffer {
  if (!(b.length > 8 && b[0] === 0x89)) return b;
  const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const parts: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (!drop.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(parts);
}

/** A safe file name stem: letters, digits, dashes; never a path. */
export function slug(name: string): string {
  const base = name.replace(/\.[^.]*$/, '').normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return base.slice(0, 40) || 'attachment';
}

const EXT: Record<Kind, string> = { png: 'png', jpeg: 'jpg', gif: 'png', webp: 'jpg', heic: 'jpg', tiff: 'jpg', pdf: 'pdf', video: '', file: '' };

const run = promisify(execFile);
/** macOS ships sips; elsewhere PNG/JPEG still attach (stripped, not rotated or shrunk), other images can't. */
const HAS_SIPS = existsSync('/usr/bin/sips');
/** macOS sips, async (a big conversion must not stall the server), 30 s at most. */
const sips = async (args: string[]): Promise<string> => (await run('sips', args, { timeout: 30_000, encoding: 'utf8' })).stdout;

/**
 * The EXIF Orientation (1–8) of a JPEG, or 1. Phones store pixels unrotated plus this tag; stripping the tag
 * without rotating would turn photos sideways.
 */
export function jpegOrientation(b: Buffer): number {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break;
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xe1 && b.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') {
      const t = i + 10; // TIFF header
      const le = b.subarray(t, t + 2).toString('latin1') === 'II';
      const u16 = (o: number): number => (o + 2 <= b.length ? (le ? b.readUInt16LE(o) : b.readUInt16BE(o)) : 0);
      const u32 = (o: number): number => (o + 4 <= b.length ? (le ? b.readUInt32LE(o) : b.readUInt32BE(o)) : 0);
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let k = 0; k < n && k < 200; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

/** sips arguments that turn an image with this orientation upright (sips rotates clockwise). */
export function uprightArgs(orientation: number): string[] {
  const r: Record<number, string[]> = { 2: ['-f', 'horizontal'], 3: ['-r', '180'], 4: ['-f', 'vertical'], 5: ['-f', 'horizontal', '-r', '270'], 6: ['-r', '90'], 7: ['-f', 'horizontal', '-r', '90'], 8: ['-r', '270'] };
  return r[orientation] ?? [];
}

export type Saved = { path: string; name: string; kind: Kind; bytes: number; original?: string; note?: string };

/**
 * Normalise and save one upload into `dir`. Images are converted (HEIC/TIFF/WebP → JPEG, GIF → first frame PNG),
 * turned upright, downscaled past 2,000 px (the original kept in `originals/`) and stripped of metadata.
 */
export async function saveAttachment(dir: string, name: string, data: Buffer, now = new Date()): Promise<Saved> {
  if (data.length === 0) throw new UserError('The file is empty.');
  if (data.length > MAX_BYTES) throw new UserError('Files up to 25 MB can be attached.');
  const kind = sniff(data);
  if (kind === 'video') throw new UserError("Claude can't watch video. Attach a screenshot instead.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`; // local time
  const ext = EXT[kind] || (extname(name).slice(1).replace(/[^\w]/g, '').slice(0, 8) || 'bin');
  let stem = `${stamp}-${slug(name)}`;
  for (let n = 2; existsSync(join(dir, `${stem}.${ext}`)); n++) stem = `${stamp}-${slug(name)}-${n}`;
  const out = join(dir, `${stem}.${ext}`);
  const saved: Saved = { path: out, name: `${stem}.${ext}`, kind, bytes: 0 };

  if (kind === 'pdf' || kind === 'file') {
    writeFileSync(out, data, { mode: 0o600 });
  } else if (!HAS_SIPS) {
    if (kind !== 'png' && kind !== 'jpeg') throw new UserError('Converting this image needs macOS. Attach a PNG or JPEG instead.');
    writeFileSync(out, kind === 'png' ? stripPng(data) : stripJpeg(data), { mode: 0o600 });
  } else {
    // convert through a private temp file; sips never sees the user's name
    const tmp = join(tmpdir(), `tend-att-${randomBytes(6).toString('hex')}`);
    try {
      writeFileSync(tmp, data, { mode: 0o600 });
      if (kind === 'heic' || kind === 'tiff' || kind === 'webp') await sips(['-s', 'format', 'jpeg', tmp, '--out', out]);
      else if (kind === 'gif') {
        await sips(['-s', 'format', 'png', tmp, '--out', out]);
        saved.note = 'GIF: first frame only';
      } else writeFileSync(out, data, { mode: 0o600 });
      // upright first (the tag is about to go), then strip
      if (ext === 'jpg') {
        const turn = uprightArgs(jpegOrientation(readFileSync(out)));
        if (turn.length) await sips([...turn, out]);
      }
      const strip = (f: string): void => {
        const b = readFileSync(f);
        writeFileSync(f, ext === 'png' ? stripPng(b) : stripJpeg(b), { mode: 0o600 });
      };
      strip(out);
      const size = await sips(['-g', 'pixelWidth', '-g', 'pixelHeight', out]);
      const w = Number(/pixelWidth: (\d+)/.exec(size)?.[1] ?? 0);
      const h = Number(/pixelHeight: (\d+)/.exec(size)?.[1] ?? 0);
      if (Math.max(w, h) > MAX_EDGE) {
        mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
        const original = join(dir, 'originals', `${stem}.${ext}`);
        renameSync(out, original);
        saved.original = original;
        await sips(['-Z', String(MAX_EDGE), original, '--out', out]);
        strip(out);
        saved.original = original;
      }
    } catch (e) {
      rmSync(out, { force: true });
      if (saved.original) rmSync(saved.original, { force: true });
      if (e instanceof UserError) throw e;
      throw new UserError('Could not read that image.');
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  saved.bytes = statSync(out).size;
  return saved;
}

/** Keep `.tend/` out of git, locally only: the repo's own info/exclude (never .gitignore, never tracked files). */
export function excludeTend(commonDir: string): void {
  const file = join(commonDir, 'info', 'exclude');
  const has = existsSync(file) && readFileSync(file, 'utf8').split('\n').some((l) => /^\/?\.tend(\/\*{0,2})?$/.test(l.trim()));
  if (has) return;
  mkdirSync(join(commonDir, 'info'), { recursive: true });
  appendFileSync(file, `${existsSync(file) && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : ''}# tend attachments\n.tend/\n`);
}

/** Where a session's attachments go: inside its worktree (excluded from git), or under Tend's home in place. */
export function attachmentDir(home: string, id: string, ws: Workspace): string {
  return ws.mode === 'worktree' ? join(ws.worktree, '.tend', 'attachments') : join(home, 'attachments', id);
}

/**
 * The attachment folder, created, and only if it really is inside the session's folder (a repo that tracks
 * `.tend` as a symlink must not redirect uploads, listings or downloads elsewhere).
 */
export function safeAttachmentDir(home: string, id: string, ws: Workspace, create = true): string {
  const dir = attachmentDir(home, id, ws);
  const root = ws.mode === 'worktree' ? ws.worktree : join(home, 'attachments');
  // only an upload creates it: listing must never recreate a paused session's removed worktree
  if (!create && !existsSync(dir)) return dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = realpathSync(dir);
  if (!real.startsWith(realpathSync(root) + '/')) throw new UserError('The attachments folder points outside the session.');
  return real;
}

/**
 * Save one upload for a session and the text to paste into its prompt: the quoted path, relative to where Claude
 * runs (worktree), or absolute (in place, reachable through --add-dir).
 */
export async function attach(o: { home: string; id: string; ws: Workspace; launchCwd: string; name: string; data: Buffer }): Promise<Saved & { insert: string }> {
  if (o.ws.mode === 'worktree') excludeTend(o.ws.commonDir);
  const saved = await saveAttachment(safeAttachmentDir(o.home, o.id, o.ws), o.name, o.data);
  const shown = o.ws.mode === 'worktree' ? relative(o.launchCwd, saved.path) : saved.path;
  return { ...saved, insert: `${JSON.stringify(shown)} ` };
}

/** The session's attachments, newest first. */
export function listAttachments(dir: string): { name: string; bytes: number; at: number }[] {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .flatMap((n) => {
        const s = lstatSync(join(dir, n));
        return s.isFile() ? [{ name: n, bytes: s.size, at: s.mtimeMs }] : []; // regular files only (originals/ is a folder)
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { excludeTend, jpegOrientation, saveAttachment, slug, sniff, stripJpeg, stripPng, uprightArgs } from '../../src/attachments.ts';
import { tempHome } from '../helpers.ts';

function png(w: number, h: number, extra: Buffer[] = []): Buffer {
  const chunk = (t: string, d: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([head, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 220;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra.map((e) => chunk('tEXt', e)), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const gpsJpeg = (): Buffer => {
  // SOI, APP0 (JFIF), APP1 (Exif with "GPS"), then a fake SOS with data, EOI
  const seg = (m: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0\x01\x01')), seg(0xe1, Buffer.from('Exif\0\0GPSLatitude=48.2')), seg(0xda, Buffer.from([1, 2, 3])), Buffer.from([9, 9, 0xff, 0xd9])]);
};

test('types come from the bytes', () => {
  assert.equal(sniff(png(1, 1)), 'png');
  assert.equal(sniff(gpsJpeg()), 'jpeg');
  assert.equal(sniff(Buffer.from('GIF89a....')), 'gif');
  assert.equal(sniff(Buffer.from('%PDF-1.7')), 'pdf');
  assert.equal(sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic')])), 'heic');
  assert.equal(sniff(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')])), 'video');
  assert.equal(sniff(Buffer.from('hello')), 'file');
});

test('metadata is stripped: JPEG APP1 (EXIF/GPS) and PNG text chunks', () => {
  const j = stripJpeg(gpsJpeg());
  assert.ok(!j.includes('GPSLatitude'));
  assert.ok(j.includes('JFIF'));
  assert.deepEqual([...j.subarray(-4)], [9, 9, 0xff, 0xd9], 'image data kept');
  const p = stripPng(png(2, 2, [Buffer.from('GPS\0somewhere')]));
  assert.ok(!p.includes('somewhere'));
  assert.equal(sniff(p), 'png');
});

test('saved with a safe name; big images downscaled with the original kept; video refused', async () => {
  const dir = join(tempHome(), 'att');
  const s = await saveAttachment(dir, '../../etc/Login bug!.png', png(3000, 900, [Buffer.from('Author\0me')]), new Date(2026, 9, 27, 14, 52));
  assert.match(s.name, /^20261027-1452-etc-login-bug\.png$/);
  assert.ok(s.path.startsWith(dir + '/'));
  assert.ok(s.original);
  const dims = execFileSync('sips', ['-g', 'pixelWidth', s.path], { encoding: 'utf8' });
  assert.match(dims, /pixelWidth: 2000/);
  assert.ok(!readFileSync(s.path).includes('Author'));
  assert.equal((await saveAttachment(dir, 'a.png', png(10, 10))).name.endsWith('.png'), true);
  await assert.rejects(saveAttachment(dir, 'clip.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')])), /can't watch video/);
  await assert.rejects(saveAttachment(dir, 'x', Buffer.alloc(0)), /empty/);
  const t = await saveAttachment(dir, 'notes.md', Buffer.from('# hi'));
  assert.ok(t.name.endsWith('-notes.md'));
  assert.deepEqual(readdirSync(dir).filter((n) => n !== 'originals').length, 3);
  assert.equal(readdirSync(join(dir, 'originals')).length, 1);
});

test('slug and info/exclude', () => {
  assert.equal(slug('Screenshot 2026-10-27 at 14.52.png'), 'screenshot-2026-10-27-at-14-52');
  assert.equal(slug('…'), 'attachment');
  const common = join(tempHome(), '.git');
  mkdirSync(join(common, 'info'), { recursive: true });
  writeFileSync(join(common, 'info', 'exclude'), '*.log');
  excludeTend(common);
  excludeTend(common);
  assert.equal(readFileSync(join(common, 'info', 'exclude'), 'utf8'), '*.log\n# tend attachments\n.tend/\n');
});

test('phone photos are turned upright before the orientation tag is stripped', async () => {
  const dir = join(tempHome(), 'att');
  mkdirSync(dir, { recursive: true });
  // a real 60×20 JPEG from sips, then an EXIF APP1 saying "rotate 90° clockwise" (orientation 6)
  const src = join(dir, 'src.png');
  writeFileSync(src, png(60, 20));
  execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', join(dir, 'src.jpg')], { stdio: 'ignore' });
  const jpg = readFileSync(join(dir, 'src.jpg'));
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const tagged = Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
  assert.equal(jpegOrientation(tagged), 6);
  assert.deepEqual(uprightArgs(6), ['-r', '90']);
  const s = await saveAttachment(join(dir, 'out'), 'phone.jpg', tagged);
  const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', s.path], { encoding: 'utf8' });
  assert.match(dims, /pixelWidth: 20/);
  assert.match(dims, /pixelHeight: 60/);
  assert.equal(jpegOrientation(readFileSync(s.path)), 1, 'tag gone');
});

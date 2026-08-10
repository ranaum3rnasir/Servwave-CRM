import { describe, it, expect } from 'vitest';
import { sniffMime, sniffMatchesDeclared } from '../lib/file-sniff';

const ATTACH = [
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'application/pdf',
] as const;
const LOGO = ['image/png', 'image/jpeg'] as const;
const AVATAR = ['image/jpeg', 'image/png', 'image/webp'] as const;

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pdf = Buffer.from('%PDF-1.7\n');
// RIFF container, size (any 4 bytes), 'WEBP' fourCC
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
// minimal ISO-BMFF box: size + 'ftyp' + brand
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]);
const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypqt  ')]);
const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]);
const heif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheif')]);
// attacker: HTML/SVG body declared as image/png
const html = Buffer.from('<svg onload="alert(1)"></svg>');

describe('sniffMime', () => {
  it('detects each allowed signature', () => {
    expect(sniffMime(jpeg)).toBe('image/jpeg');
    expect(sniffMime(png)).toBe('image/png');
    expect(sniffMime(pdf)).toBe('application/pdf');
    expect(sniffMime(mp4)).toBe('video/mp4');
    expect(sniffMime(mov)).toBe('video/quicktime');
    expect(sniffMime(heic)).toBe('image/heic');
    expect(sniffMime(heif)).toBe('image/heif');
    expect(sniffMime(webp)).toBe('image/webp');
  });
  it('does not mistake a RIFF container for WEBP without the WEBP fourCC (e.g. a WAV file)', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);
    expect(sniffMime(wav)).toBeNull();
  });
  it('returns null for unrecognised / HTML bytes', () => {
    expect(sniffMime(html)).toBeNull();
    expect(sniffMime(Buffer.from('not a file'))).toBeNull();
    expect(sniffMime(Buffer.from([]))).toBeNull();
  });
});

describe('sniffMatchesDeclared', () => {
  it('accepts a true match within the allowlist', () => {
    expect(sniffMatchesDeclared(png, 'image/png', ATTACH)).toBe(true);
    expect(sniffMatchesDeclared(jpeg, 'image/jpeg', LOGO)).toBe(true);
    expect(sniffMatchesDeclared(pdf, 'application/pdf', ATTACH)).toBe(true);
  });
  it('rejects spoofed Content-Type (HTML body declared image/png) — F-35', () => {
    expect(sniffMatchesDeclared(html, 'image/png', ATTACH)).toBe(false);
    expect(sniffMatchesDeclared(html, 'image/png', LOGO)).toBe(false);
  });
  it('rejects a real file whose bytes disagree with the header', () => {
    expect(sniffMatchesDeclared(pdf, 'image/png', ATTACH)).toBe(false);
    expect(sniffMatchesDeclared(jpeg, 'image/png', LOGO)).toBe(false);
  });
  it('rejects a type not in the given allowlist (PDF on the logo allowlist)', () => {
    expect(sniffMatchesDeclared(pdf, 'application/pdf', LOGO)).toBe(false);
  });
  it('tolerates HEIC/HEIF and mp4/quicktime family cross-labelling', () => {
    expect(sniffMatchesDeclared(heic, 'image/heif', ATTACH)).toBe(true);
    expect(sniffMatchesDeclared(heif, 'image/heic', ATTACH)).toBe(true);
    expect(sniffMatchesDeclared(mov, 'video/mp4', ATTACH)).toBe(true);
    expect(sniffMatchesDeclared(mp4, 'video/quicktime', ATTACH)).toBe(true);
  });
  it('rejects SVG declared as image/png on the logo path — F-36 backstop', () => {
    // even if SVG were re-added to an allowlist, its bytes never sniff to an image
    expect(sniffMatchesDeclared(Buffer.from('<svg/>'), 'image/svg+xml', LOGO)).toBe(false);
  });
  it('accepts WEBP on the avatar allowlist but rejects it on allowlists that never listed it', () => {
    expect(sniffMatchesDeclared(webp, 'image/webp', AVATAR)).toBe(true);
    expect(sniffMatchesDeclared(webp, 'image/webp', ATTACH)).toBe(false);
    expect(sniffMatchesDeclared(webp, 'image/webp', LOGO)).toBe(false);
  });
});

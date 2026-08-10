/**
 * Zero-dependency magic-byte content sniffing for the upload allowlists.
 *
 * Upload handlers must NOT trust the client-supplied multipart Content-Type
 * (multer derives `file.mimetype` straight from the attacker-controlled header).
 * This inspects the actual leading bytes and returns the detected MIME, or null
 * if the signature is unrecognised. Callers reject when the sniffed type is
 * absent or disagrees with the declared header (F-35).
 *
 * Covers exactly the three project allowlists:
 *   attachments:    image/jpeg, image/png, image/heic, image/heif,
 *                   video/mp4, video/quicktime, application/pdf
 *   org logos:      image/jpeg, image/png   (SVG intentionally NOT sniffable — F-36)
 *   staff avatars:  image/jpeg, image/png, image/webp
 */
function bytesAt(buf: Buffer, offset: number, sig: number[]): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(buf: Buffer, offset: number, str: string): boolean {
  return bytesAt(buf, offset, Array.from(str, (c) => c.charCodeAt(0)));
}

export function sniffMime(buf: Buffer): string | null {
  // JPEG: FF D8 FF
  if (bytesAt(buf, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytesAt(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // PDF: %PDF
  if (ascii(buf, 0, '%PDF')) return 'application/pdf';
  // WEBP: RIFF container (bytes 0-3), size (4-7), 'WEBP' fourCC (8-11)
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'image/webp';
  // ISO-BMFF (mp4 / quicktime / heic): bytes 4-7 == 'ftyp', brand at 8-11
  if (ascii(buf, 4, 'ftyp')) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'heic' || brand === 'heix' || brand === 'heif' || brand === 'mif1' || brand === 'msf1') {
      return brand === 'heif' || brand === 'msf1' ? 'image/heif' : 'image/heic';
    }
    // isom/mp41/mp42/iso2/avc1/dash/M4V … → treat as mp4
    return 'video/mp4';
  }
  return null;
}

/**
 * True when the sniffed bytes are consistent with the declared header against
 * the given allowlist. HEIC/HEIF and mp4/quicktime are treated as
 * interchangeable families so a legit photo declared image/heic but sniffed
 * image/heif (or vice-versa) is not falsely rejected.
 */
const FAMILIES: Record<string, string> = {
  'image/heic': 'heif-family', 'image/heif': 'heif-family',
  'video/mp4': 'mp4-family', 'video/quicktime': 'mp4-family',
};

export function sniffMatchesDeclared(buf: Buffer, declared: string, allowed: readonly string[]): boolean {
  const sniffed = sniffMime(buf);
  if (!sniffed || !allowed.includes(sniffed)) return false;
  if (sniffed === declared) return true;
  return !!FAMILIES[sniffed] && FAMILIES[sniffed] === FAMILIES[declared];
}

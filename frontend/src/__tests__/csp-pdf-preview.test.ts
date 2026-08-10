import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The PDF previews (estimate/invoice dialog, Branding live preview, Org settings)
// render the generated PDF as `<iframe src={blob-url}>`. The deployed CSP lives in
// frontend/vercel.json; if `frame-src` omits `blob:`, the browser blocks the iframe
// ("This content is blocked"). Guard against that regression — the preview has broken
// this way before.
function deployedCsp(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cfg = JSON.parse(readFileSync(join(here, '../../vercel.json'), 'utf8'));
  for (const route of cfg.headers ?? []) {
    for (const h of route.headers ?? []) {
      if (String(h.key).toLowerCase() === 'content-security-policy') return String(h.value);
    }
  }
  return '';
}

describe('deployed CSP (frontend/vercel.json)', () => {
  it('frame-src allows blob: so blob-URL PDF previews can render in an iframe', () => {
    const csp = deployedCsp();
    const frameSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-src')) ?? '';
    expect(frameSrc, `frame-src directive was: "${frameSrc}"`).toContain('blob:');
  });
});

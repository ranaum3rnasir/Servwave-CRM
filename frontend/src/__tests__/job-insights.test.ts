import { deriveJobInsights } from '@/lib/jobs/insights';

it('flags missing after-photos for an on-site job', () => {
  const out = deriveJobInsights({ status: 'ON_SITE', signature_at: null }, [{ context: 'BEFORE_PHOTO' }], {});
  expect(out.map((i) => i.key)).toContain('missing_photos');
});
it('does NOT flag missing photos once an after-photo exists', () => {
  const out = deriveJobInsights({ status: 'COMPLETED', signature_at: '2026-05-12T00:00:00Z' }, [{ context: 'AFTER_PHOTO' }], {});
  expect(out.map((i) => i.key)).not.toContain('missing_photos');
});
it('does NOT nag for a signature on a completed unsigned job (signature capture removed)', () => {
  const out = deriveJobInsights({ status: 'COMPLETED', signature_at: null }, [{ context: 'AFTER_PHOTO' }], {});
  expect(out.map((i) => i.key)).not.toContain('awaiting_signature');
});
it('returns no insights for a brand-new unassigned job', () => {
  const out = deriveJobInsights({ status: 'UNASSIGNED', signature_at: null }, [], {});
  expect(out).toEqual([]);
});

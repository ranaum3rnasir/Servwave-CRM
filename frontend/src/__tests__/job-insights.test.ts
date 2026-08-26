import { deriveJobInsights } from '@/lib/jobs/insights';

// Multi-visit S4 (D17): ON_SITE retired from JobStatus and lives on VisitStatus, so a JOB can no
// longer hold it - a crew on site leaves the job SCHEDULED and the nudge starts once work has
// actually started. The fixture moves to IN_PROGRESS because that is the state this test was
// always about: work under way, before-photo taken, after-photo still missing.
it('flags missing after-photos once work on the job has started', () => {
  const out = deriveJobInsights({ status: 'IN_PROGRESS', signature_at: null }, [{ context: 'BEFORE_PHOTO' }], {});
  expect(out.map((i) => i.key)).toContain('missing_photos');
});

// The other half of the same rule: a job merely booked, or with a crew on the way or on site,
// reads SCHEDULED now, and nagging for an after-photo before anyone has started is noise.
it('does NOT flag missing photos on a job that is only scheduled', () => {
  const out = deriveJobInsights({ status: 'SCHEDULED', signature_at: null }, [{ context: 'BEFORE_PHOTO' }], {});
  expect(out.map((i) => i.key)).not.toContain('missing_photos');
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
  const out = deriveJobInsights({ status: 'UNSCHEDULED', signature_at: null }, [], {});
  expect(out).toEqual([]);
});

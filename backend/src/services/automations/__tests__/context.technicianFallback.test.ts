import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle, visitMergeFields } from '../context';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import { renderMergeFields } from '../renderMergeFields';

const mockPrisma = prisma as any;

/**
 * Regression coverage for the dangling "Who's coming: ." defect.
 *
 * {{technician.names}} resolved to '' for a crewless job/visit, so the seeded copy in
 * defaultAutomations.ts ('default-job-scheduled', 'default-job-rescheduled',
 * 'default-job-en-route' — all "Who's coming: {{technician.names}}.") rendered
 * "Who's coming: . Address: ...". The hard-coded email path already solved this
 * identical case (job.controller.ts's sendJobVisitScheduledEmail technicianName /
 * lead.controller.ts's performerName, both `|| 'Our team'`); context.ts's two
 * independent resolvers now match it. See also automation-wiring.test.ts:532, which
 * documents the same underlying bug from the JOB_EN_ROUTE dispatch-gate side (a
 * different file, owned by a different contract — not touched here).
 */

describe('visitMergeFields — crew fallback', () => {
  const VISIT = { scheduled_at: new Date('2026-08-01T15:00:00.000Z') };
  const TZ = 'America/New_York';

  it("resolves 'technician.names' to 'Our team' for an empty crew", () => {
    const fields = visitMergeFields(VISIT, [], TZ);
    expect(fields['technician.names']).toBe('Our team');
  });

  it("resolves 'technician.names' to the joined crew names, unchanged, when a crew exists", () => {
    const fields = visitMergeFields(
      VISIT,
      [
        { first_name: 'Mike', last_name: 'Torres' },
        { first_name: 'Dre', last_name: 'Patel' },
      ],
      TZ,
    );
    expect(fields['technician.names']).toBe('Mike Torres, Dre Patel');
  });
});

describe('loadExecutionBundle — job mergeCtx crew fallback', () => {
  const ORG = '00000000-0000-0000-0000-000000000001';
  const JOB_ID = 'b0000000-0000-0000-0000-000000000002';

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Blue Ridge Plumbing',
      phone: '(555) 204-7788',
      timezone: 'America/New_York',
      currency: 'USD',
      logo_url: null,
      brand_color: '#0C2D3A',
    });
  });

  it("resolves 'technician.names' to 'Our team' when the job's trips carry no assignees", async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce({
      id: JOB_ID,
      job_number: 'J00099',
      status: 'SCHEDULED',
      scheduled_start: new Date('2026-08-01T15:00:00.000Z'),
      job_type: 'Repair',
      scope_notes: null,
      customer: { id: 'c1', first_name: 'Sarah', last_name: 'Mitchell', email: 's@example.com', phone: null },
      service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
      // S8 (D6): the job's crew is the union across its trips — no trips/no assignees is the
      // crewless case this fallback exists for.
      visits: [{ assignees: [] }],
      dispatcher: null,
      salesperson: null,
      estimate: null,
    });

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-crewless',
    });

    expect(result!.bundle.mergeCtx['technician.names']).toBe('Our team');
  });
});

describe("seeded 'default-job-scheduled' rendering — crewless job", () => {
  it('does not render a dangling "coming: ." for a job with no crew', () => {
    const automation = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-job-scheduled')!;
    // The mergeCtx shape loadExecutionBundle/visitMergeFields now produce for a
    // crewless job/visit — 'technician.names' is 'Our team', never ''.
    const ctx: Record<string, string> = {
      'customer.first_name': 'Sarah',
      'job.number': 'J00099',
      'job.scheduled_date': 'Sat, Aug 1',
      'job.scheduled_time': '11:00 AM',
      'job.address': '123 Main St, Raleigh, NC',
      'technician.names': 'Our team',
    };

    const rendered = renderMergeFields(automation.body, ctx, { html: false });

    expect(rendered).not.toContain('coming: .');
    expect(rendered).toContain("Who's coming: Our team.");
  });
});

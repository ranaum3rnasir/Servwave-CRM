import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle } from '../context';

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const SCHEDULED_AT = new Date('2026-08-01T15:00:00.000Z');

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    job_number: 'J00042',
    status: 'SCHEDULED',
    scheduled_start: SCHEDULED_AT,
    job_type: 'Repair',
    scope_notes: 'Replace 40gal water heater; shut-off is in the crawlspace',
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@example.com',
      phone: '+15551234567',
    },
    service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
    assignees: [
      {
        user: {
          id: 't0000000-0000-0000-0000-000000000001',
          email: 'mike@example.com',
          first_name: 'Mike',
          last_name: 'Torres',
        },
      },
    ],
    dispatcher: null,
    salesperson: null,
    estimate: null,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.job.findFirst.mockResolvedValue(jobRow());
});

describe('loadExecutionBundle — job merge fields', () => {
  // The built-in crew-assignment email carries the scope notes; without this
  // token the automation that replaces it tells the tech what to do but not what
  // the work actually is.
  it('exposes the job’s scope notes, empty rather than undefined when unset', async () => {
    const withNotes = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-scope',
    });
    expect(withNotes!.bundle.mergeCtx['job.scope_notes']).toBe(
      'Replace 40gal water heater; shut-off is in the crawlspace',
    );

    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow({ scope_notes: null }));
    const without = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-scope-2',
    });
    expect(without!.bundle.mergeCtx['job.scope_notes']).toBe('');
  });

  // SRVW-113 — JOB_SUB_STATUS_ENTERED's merge field. Most job triggers fire on
  // a job with no sub-status set at all, so the empty case is the common one.
  it('exposes the job’s sub-status label, empty rather than undefined when unset', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow({ sub_status: { label: 'Waiting on parts' } }));
    const withSubStatus = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-sub-status',
    });
    expect(withSubStatus!.bundle.mergeCtx['job.sub_status']).toBe('Waiting on parts');

    const without = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-sub-status-2',
    });
    expect(without!.bundle.mergeCtx['job.sub_status']).toBe('');
  });
});

describe('loadExecutionBundle — job people', () => {
  it('populates dispatcher + salesperson from a job that has both', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRow({
        dispatcher: {
          id: 'd0000000-0000-0000-0000-000000000001',
          email: 'dana@example.com',
          first_name: 'Dana',
          last_name: 'Chu',
        },
        salesperson: {
          id: 's0000000-0000-0000-0000-000000000001',
          email: 'sam@example.com',
          first_name: 'Sam',
          last_name: 'Lee',
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k1',
    });

    expect(result!.bundle.dispatcher).toEqual({
      id: 'd0000000-0000-0000-0000-000000000001',
      email: 'dana@example.com',
      first_name: 'Dana',
      last_name: 'Chu',
    });
    expect(result!.bundle.salesperson).toEqual({
      id: 's0000000-0000-0000-0000-000000000001',
      email: 'sam@example.com',
      first_name: 'Sam',
      last_name: 'Lee',
    });
  });

  it('falls back to the linked lead owner when job.salesperson_id is null', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRow({
        salesperson: null,
        estimate: {
          lead: {
            commission_owner: {
              id: 'o0000000-0000-0000-0000-000000000001',
              email: 'owen@example.com',
              first_name: 'Owen',
              last_name: 'Ortiz',
            },
          },
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k2',
    });

    expect(result!.bundle.salesperson).toEqual({
      id: 'o0000000-0000-0000-0000-000000000001',
      email: 'owen@example.com',
      first_name: 'Owen',
      last_name: 'Ortiz',
    });
  });

  it('prefers job.salesperson_id over the lead owner when both are present', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRow({
        salesperson: {
          id: 's0000000-0000-0000-0000-000000000001',
          email: 'sam@example.com',
          first_name: 'Sam',
          last_name: 'Lee',
        },
        estimate: {
          lead: {
            commission_owner: {
              id: 'o0000000-0000-0000-0000-000000000001',
              email: 'owen@example.com',
              first_name: 'Owen',
              last_name: 'Ortiz',
            },
          },
        },
      }),
    );

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k3',
    });

    expect(result!.bundle.salesperson!.id).toBe('s0000000-0000-0000-0000-000000000001');
  });

  it('is null when neither job.salesperson_id nor a linked lead owner exists', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow({ salesperson: null, estimate: null }));

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k4',
    });

    expect(result!.bundle.salesperson).toBeNull();
  });

  it('is null when the job has no estimate/lead and no direct salesperson (dispatcher likewise null)', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k5',
    });

    expect(result!.bundle.dispatcher).toBeNull();
    expect(result!.bundle.salesperson).toBeNull();
  });

  it('keeps assignees as the job crew (unaffected by the new people fields)', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k6',
    });

    expect(result!.bundle.assignees).toEqual([
      {
        id: 't0000000-0000-0000-0000-000000000001',
        email: 'mike@example.com',
        first_name: 'Mike',
        last_name: 'Torres',
      },
    ]);
  });
});

// The removed-technician's identity survives every WAIT step (context.ts
// re-loads fresh every step, but the removed person is off the LIVE crew by
// then) only if it's carried through the enrollment's persisted event_payload
// and merged back in here on every load.
describe('loadExecutionBundle — event payload', () => {
  it('exposes eventPayload.recipient as bundle.eventRecipient', async () => {
    const removed = { id: 'r1', email: 'removed@example.com', first_name: 'Priya', last_name: 'Nair' };
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload',
      eventPayload: { recipient: removed },
    });
    expect(result!.bundle.eventRecipient).toEqual(removed);
  });

  it('bundle.eventRecipient is null when no eventPayload is given (every existing trigger)', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload-2',
    });
    expect(result!.bundle.eventRecipient).toBeNull();
  });

  it('merges eventPayload.mergeFields into mergeCtx, without clobbering entity-derived fields it does not name', async () => {
    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-payload-3',
      eventPayload: { mergeFields: { 'event.reason': 'Customer requested reschedule' } },
    });
    expect(result!.bundle.mergeCtx['event.reason']).toBe('Customer requested reschedule');
    expect(result!.bundle.mergeCtx['job.number']).toBe('J00042');
  });
});

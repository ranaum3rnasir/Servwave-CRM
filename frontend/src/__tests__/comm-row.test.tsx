// Slice E6 — the shared CommRow renderer behind the Job/Customer/Lead
// Communication tabs. Contract under test:
//   • Standard line: direction word · who · "answered by X" (calls) · meta.
//   • Job chip navigates to /jobs/:id — EXCEPT the hosting job page's own rows
//     (plain pill, no self-link).
//   • NEW lead chip (LeadBadge) navigates to /leads/:id — EXCEPT the hosting
//     lead page's own rows.
//   • Unattributed rows keep the muted "no job" pill (badge it, don't hide it).
// Gate-off rendering (static/navigable chips) is the default here: no
// `ability` is passed to renderWithProviders, so the default empty CASL
// ability denies update:Communication regardless of useFeature('phone') —
// the interactive reassign menu never renders. The gated menu behavior lives
// in comm-row-job-control.test.tsx.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { CommRow } from '@/components/communication/shared/CommRow';
import type { CommItem } from '@/lib/api/jobCommunications';

const JOB_ID = 'b0000000-0000-0000-0000-000000000042';
const LEAD_ID = 'e0000000-0000-0000-0000-000000000007';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

const CALL_ITEM: CommItem = {
  id: 'ca000000-0000-0000-0000-000000000001',
  channel: 'call',
  direction: 'in',
  who: 'Doe HVAC',
  title: 'Inbound call · 4m 07s',
  preview: 'Confirmed Thursday 8am.',
  at: '2026-06-01T14:32:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
  leadId: LEAD_ID,
  leadLabel: 'L00007',
  answeredBy: 'Dana Reyes',
  meta: 'Booked',
};

const fmt = (at: string) => new Date(at).toISOString();

function renderRow(item: CommItem, props: Partial<Parameters<typeof CommRow>[0]> = {}) {
  return renderWithProviders(
    <ol>
      <CommRow
        item={item}
        formatTimestamp={fmt}
        tz="America/New_York"
        customerId={CUSTOMER_ID}
        {...props}
      />
    </ol>
  );
}

describe('CommRow — standard line', () => {
  it('renders direction word, who, answered-by and meta', () => {
    renderRow(CALL_ITEM);

    expect(screen.getByText('Inbound')).toBeInTheDocument();
    expect(screen.getByText(/· Doe HVAC/)).toBeInTheDocument();
    expect(screen.getByText('· answered by Dana Reyes')).toBeInTheDocument();
    expect(screen.getByText('· Booked')).toBeInTheDocument();
    expect(screen.getByText('Inbound call · 4m 07s')).toBeInTheDocument();
    expect(screen.getByText('Confirmed Thursday 8am.')).toBeInTheDocument();
  });

  it('omits the answered-by fragment when the item has none', () => {
    renderRow({ ...CALL_ITEM, answeredBy: undefined });

    expect(screen.queryByText(/answered by/)).not.toBeInTheDocument();
  });
});

describe('CommRow — chip navigation', () => {
  it('links the job pill to /jobs/:id and the lead chip to /leads/:id', () => {
    renderRow(CALL_ITEM);

    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${JOB_ID}`);
    expect(screen.getByText('L00007').closest('a')).toHaveAttribute('href', `/leads/${LEAD_ID}`);
  });

  it('suppresses the job self-link on the job page (plain pill, lead chip still navigates)', () => {
    renderRow(CALL_ITEM, { currentJobId: JOB_ID });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.getByText('J00042').closest('a')).toBeNull();
    expect(screen.getByText('L00007').closest('a')).toHaveAttribute('href', `/leads/${LEAD_ID}`);
  });

  it('suppresses the lead self-link on the lead page (plain chip, job pill still navigates)', () => {
    renderRow(CALL_ITEM, { currentLeadId: LEAD_ID });

    expect(screen.getByText('L00007')).toBeInTheDocument();
    expect(screen.getByText('L00007').closest('a')).toBeNull();
    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${JOB_ID}`);
  });

  it('keeps the muted "no job" pill (unlinked) and no lead chip for an unattributed row', () => {
    renderRow({
      ...CALL_ITEM,
      jobId: undefined,
      jobLabel: undefined,
      leadId: undefined,
      leadLabel: undefined,
    });

    const noJob = screen.getByText('no job');
    expect(noJob).toBeInTheDocument();
    expect(noJob.closest('a')).toBeNull();
    expect(screen.queryByText('L00007')).not.toBeInTheDocument();
  });

  it('renders a legacy labelled-but-id-less job pill as plain text (no link target)', () => {
    renderRow({ ...CALL_ITEM, jobId: undefined });

    expect(screen.getByText('J00042')).toBeInTheDocument();
    expect(screen.getByText('J00042').closest('a')).toBeNull();
  });
});

describe('CommRow — row selection (opens the detail drawer)', () => {
  it('calls onSelect with the item when the row body is clicked', async () => {
    const onSelect = vi.fn();
    renderRow(CALL_ITEM, { onSelect });

    await userEvent.click(screen.getByText('Inbound call · 4m 07s'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(CALL_ITEM);
  });

  it('exposes the row as a button (keyboard-activatable) when selectable', async () => {
    const onSelect = vi.fn();
    renderRow(CALL_ITEM, { onSelect });

    const row = screen.getByRole('button');
    row.focus();
    await userEvent.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does NOT open the drawer when a job/lead chip is clicked (chip navigation wins)', async () => {
    const onSelect = vi.fn();
    renderRow(CALL_ITEM, { onSelect });

    // The job pill and lead chip are navigating links inside the row — their
    // clicks must not bubble up and also open the drawer.
    await userEvent.click(screen.getByText('J00042'));
    await userEvent.click(screen.getByText('L00007'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('is not interactive (no button role) without onSelect', () => {
    renderRow(CALL_ITEM);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

// Email slice 5 — the delivery-state pill CommRow renders for a sent Email
// item, feeding the Job/Customer/Lead Communication tabs (the shared
// aggregator, backend lib/job-communications.ts, is where deliveryStatus is
// actually populated; this suite only covers CommRow's own render logic).
describe('CommRow — email delivery pill (slice 5)', () => {
  const SENT_EMAIL_ITEM: CommItem = {
    id: 'em000000-0000-0000-0000-000000000001',
    channel: 'email',
    direction: 'out',
    who: 'Doe HVAC',
    title: 'Estimate E00042 from ServWave',
    preview: 'Your estimate is ready.',
    at: '2026-06-01T09:12:00.000Z',
    transactional: true,
  };

  it('renders the delivery pill for a sent email with a known deliveryStatus', () => {
    renderRow({ ...SENT_EMAIL_ITEM, deliveryStatus: 'BOUNCED', deliveryStatusReason: 'mailbox unavailable' });

    expect(screen.getByText('Bounced')).toBeInTheDocument();
  });

  it('renders nothing extra when the email row has no deliveryStatus yet', () => {
    renderRow(SENT_EMAIL_ITEM);

    expect(screen.queryByText('Bounced')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('never renders the pill for an inbound email (delivery state is an outbound-only fact)', () => {
    renderRow({ ...SENT_EMAIL_ITEM, direction: 'in', deliveryStatus: 'DELIVERED' });

    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('never renders the pill for a non-email channel, even if deliveryStatus were somehow set', () => {
    renderRow({ ...CALL_ITEM, deliveryStatus: 'DELIVERED' } as CommItem);

    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('a BOUNCED sent email never renders through StateChip\'s sage styling', () => {
    const { container } = renderRow({ ...SENT_EMAIL_ITEM, deliveryStatus: 'BOUNCED' });

    // StateChip's one legitimate use is sage (bg-sage-50) for a genuine
    // business state (Approved/Paid) - a bounce must never share that class.
    expect(container.innerHTML).not.toContain('bg-sage-50');
  });
});

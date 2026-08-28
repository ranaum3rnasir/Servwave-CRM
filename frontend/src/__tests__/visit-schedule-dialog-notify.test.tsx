/**
 * Q1 (RATIFIED, decline-expressible half) - VisitScheduleDialog is one of the three hosts named
 * in the contract: its composer (NotifyComposeFields) is rendered UNCONDITIONALLY whenever the
 * dialog is open, so every submission through it is a "composer was shown" submission - there is
 * no silent path through this particular host to preserve.
 *
 * Before this fix, leaving the box unticked (still the default - see notifyCompose.ts and this
 * agent's report for why the default-ON half of Q1 is NOT implemented here) posted `{}`, byte-
 * identical to a caller that never showed a dialog at all. The backend then reads the absent
 * `notify` as "let the JOB_SCHEDULED/JOB_RESCHEDULED automation handle it", so the automation's
 * own template can still email the customer even though the dispatcher explicitly left this
 * dialog's box off.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import api from '@/lib/axios';
import { VisitScheduleDialog } from '@/pages/v2/jobs/components/visitScheduleDialog';

const post = api.post as ReturnType<typeof vi.fn>;

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VisitScheduleDialog
        open
        onOpenChange={() => {}}
        jobId="job-1"
        canAssignCrew={false}
        customerName="Dana Reyes"
        customerEmail="dana@example.com"
      />
    </QueryClientProvider>,
  );
}

/** Fills the four required fields so the Book button is enabled, then blurs the last one. */
async function fillWindow(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Start date'), '09/01/2026');
  await user.tab();
  await user.type(screen.getByLabelText('Start time'), '9:00 AM');
  await user.tab();
  await user.type(screen.getByLabelText('End date'), '09/01/2026');
  await user.tab();
  await user.type(screen.getByLabelText('End time'), '11:00 AM');
  await user.tab();
}

describe('VisitScheduleDialog - the composer is always on screen, so an untick must be explicit', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  it('starts with the box ON (D23: opt-out, defaulted on) and an untick books an explicit decline', async () => {
    const user = userEvent.setup();
    renderDialog();

    // D23 / user story 42: the box defaults to sending. An untick is a decision made in front
    // of the user, and must reach the wire as an explicit `false`, not an absent key.
    expect(screen.getByRole('checkbox', { name: 'Notify the customer' })).toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Notify the customer' }));
    await fillWindow(user);
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.notify).toEqual({ notify_customer: false });
  });

  it('left as it opens, booking sends notify_customer: true with the recipient and message', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Message'), 'See you soon.');
    await fillWindow(user);
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.notify).toEqual({
      notify_customer: true,
      notify_recipient_email: 'dana@example.com',
      notify_message: 'See you soon.',
    });
  });

  // The write awaits the customer notify email server-side and can legitimately take seconds
  // (founder acceptance feedback: a grey-but-unlabelled button read as stuck). Deliberately never
  // resolves the post - the assertion is on the busy render, not on what happens after it settles.
  it('shows the busy label and stays disabled while the save is still in flight', async () => {
    const user = userEvent.setup();
    post.mockReturnValue(new Promise(() => {}));
    renderDialog();

    await fillWindow(user);
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    const busyButton = await screen.findByRole('button', { name: 'Booking...' });
    expect(busyButton).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Book visit' })).not.toBeInTheDocument();
  });
});

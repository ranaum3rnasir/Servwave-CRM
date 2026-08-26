/**
 * RescheduleConfirmDialog - the notify composer (SRVW-243, ported to v2 by S7).
 *
 * This dialog used to assert "Notification emails will be sent to:" over a recipient list
 * assembled client-side, on a server that had sent nothing since PR #1003 deleted the
 * transactional senders. Then it became an honest checkbox with no visibility into the send. Now
 * it is a composer. What must stay true:
 *
 *   1. It never claims a send it does not control. Only the tick sends.
 *   2. Default OFF. The customer who prompted this deals with realtors, and a mail on every slot
 *      shift is the complaint, not the feature.
 *   3. Ticked, the user can SEE and CHANGE who it goes to and what it says before it leaves - the
 *      gap that made the first cut feel like a black box.
 *
 * ─── WHY THIS FILE MOVED ─────────────────────────────────────────────────────
 *
 * It used to live at `__tests__/reschedule-confirm-notify.test.tsx` and import
 * `components/schedule/RescheduleConfirmDialog` - the v1 dialog, whose only other importer was
 * the unrouted `pages/SchedulePage.tsx`. Both are now deleted, so these three contracts are
 * asserted against the dialog `v2Routes()` actually mounts. A regression test that imports an
 * unreachable module proves nothing about the shipped app, which is the whole lesson of #1625.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { NotifyCompose } from '@/lib/notifyCompose';

import { RescheduleConfirmDialog } from '../components/rescheduleConfirmDialog';

const CLOSED: NotifyCompose = { enabled: false, to: 'john@doe.com', cc: [], message: 'We moved you.' };
const OPEN: NotifyCompose = { ...CLOSED, enabled: true };

const BASE = {
  open: true,
  eventType: 'job' as const,
  eventNumber: 'J00042',
  oldStart: new Date('2026-08-01T09:00:00'),
  oldEnd: new Date('2026-08-01T11:00:00'),
  newStart: new Date('2026-08-02T13:00:00'),
  newEnd: new Date('2026-08-02T15:00:00'),
  crewNames: ['Test Tech'],
  customerName: 'John Doe',
  customerEmail: 'john@doe.com',
  notify: CLOSED,
  onNotifyChange: vi.fn(),
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('RescheduleConfirmDialog - customer notification', () => {
  it('never asserts that notification emails are being sent', () => {
    render(<RescheduleConfirmDialog {...BASE} />);

    expect(screen.queryByText(/notification emails will be sent/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm & notify/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm reschedule/i })).toBeInTheDocument();
  });

  it('keeps the composer collapsed until the user opts in', () => {
    render(<RescheduleConfirmDialog {...BASE} />);

    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  });

  it('names the exact address the tick would mail, not just the customer', () => {
    render(<RescheduleConfirmDialog {...BASE} />);

    // D23. A label-only opt-out ("Email John Doe") re-lands the reported bug: the old panel
    // listed DISPLAY NAMES and the reader could not tell which address, if any, it meant.
    expect(screen.getByText('Email john@doe.com')).toBeInTheDocument();
  });

  it('reveals To, CC and Message once ticked, prefilled and editable', () => {
    render(<RescheduleConfirmDialog {...BASE} notify={OPEN} />);

    expect(screen.getByLabelText('To')).toHaveValue('john@doe.com');
    expect(screen.getByLabelText('Message')).toHaveValue('We moved you.');
    expect(screen.getByLabelText(/CC/)).toBeInTheDocument();
  });

  it('renames the confirm button once a send is attached to it', () => {
    render(<RescheduleConfirmDialog {...BASE} notify={OPEN} />);

    expect(screen.getByRole('button', { name: /reschedule & send/i })).toBeInTheDocument();
  });

  it('reports edits to the parent rather than owning the state', async () => {
    const onNotifyChange = vi.fn();
    render(<RescheduleConfirmDialog {...BASE} notify={OPEN} onNotifyChange={onNotifyChange} />);

    await userEvent.type(screen.getByLabelText('Message'), '!');

    expect(onNotifyChange).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'We moved you.!' }),
    );
  });

  it('blocks the send on a malformed recipient rather than mailing nowhere', () => {
    render(<RescheduleConfirmDialog {...BASE} notify={{ ...OPEN, to: 'not-an-email' }} />);

    expect(screen.getByRole('button', { name: /reschedule & send/i })).toBeDisabled();
    expect(screen.getByText(/enter a valid email address/i)).toBeInTheDocument();
  });

  it('allows an empty recipient, which falls back to the address on file', () => {
    render(<RescheduleConfirmDialog {...BASE} notify={{ ...OPEN, to: '' }} />);

    expect(screen.getByRole('button', { name: /reschedule & send/i })).toBeEnabled();
  });

  it('offers the control even with no address on file, saying so instead of hiding', () => {
    render(<RescheduleConfirmDialog {...BASE} customerName={null} customerEmail={null} />);

    // A DELIBERATE change from v1, which hid the whole control when the event had no customer
    // name. v2 keeps it and explains the state, because the To field is editable: a dispatcher
    // who knows the address can still send, where v1 gave them no way to. The important half of
    // the old behaviour survives - nothing claims a send it cannot make.
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByText(/no email address on file/i)).toBeInTheDocument();
  });

  it('still lets the user confirm the move with the box left unticked', async () => {
    const onConfirm = vi.fn();
    render(<RescheduleConfirmDialog {...BASE} onConfirm={onConfirm} />);

    await userEvent.click(screen.getByRole('button', { name: /confirm reschedule/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

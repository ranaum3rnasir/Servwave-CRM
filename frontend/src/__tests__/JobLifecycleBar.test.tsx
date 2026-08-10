import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobLifecycleBar } from '@/components/jobs/JobLifecycleBar';

const baseJob = {
  created_at: '2026-03-01T09:00:00Z',
  scheduled_start: '2026-03-02T09:00:00Z',
  on_site_at: null,
  completed_at: null,
  status: 'SCHEDULED',
  cancelled_at: null,
};
const allCan = { scheduled: true, on_site: true, started: true, completed: true };

describe('JobLifecycleBar interactivity', () => {
  it('renders job nodes as buttons when the user holds the capability', async () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={allCan} onNodeClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /on site/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /completed/i })).toBeInTheDocument();
  });

  it('renders a node inert — not a disabled button — when the capability is absent', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={{ on_site: false }} onNodeClick={vi.fn()} />);
    // No disabled-looking affordance for a permission they will never have.
    expect(screen.queryByRole('button', { name: /on site/i })).not.toBeInTheDocument();
  });

  it('makes the invoice nodes interactive when the capability is held', async () => {
    const onNodeClick = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined}
      can={{ ...allCan, invoice_sent: true, payment_received: true }} onNodeClick={onNodeClick} />);
    await userEvent.click(screen.getByRole('button', { name: /invoice sent/i }));
    expect(onNodeClick).toHaveBeenCalledWith('invoice_sent');
  });

  it('leaves the invoice nodes inert without the capability', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined}
      can={{ ...allCan, invoice_sent: false, payment_received: false }} onNodeClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /invoice sent/i })).not.toBeInTheDocument();
  });

  it('keeps Invoice Sent clickable when it IS the current stage — clicking opens the invoice', async () => {
    // B1's `!stage.current` rule is right for job nodes (re-stamping completed_at is a no-op) but
    // wrong here: State 1's whole behaviour is "open the invoice", which is only reachable from
    // the node the job is currently at.
    const onNodeClick = vi.fn();
    render(<JobLifecycleBar
      job={{ ...baseJob, status: 'COMPLETED', completed_at: '2026-03-02T16:00:00Z' }}
      financials={{ final_invoice: { id: 'i1', invoice_number: 'I00001', status: 'SENT', sent_at: '2026-03-10T12:00:00Z', paid_at: null }, first_sent_at: '2026-03-10T12:00:00Z' } as never}
      can={{ ...allCan, invoice_sent: true }} onNodeClick={onNodeClick} />);
    await userEvent.click(screen.getByRole('button', { name: /invoice sent/i }));
    expect(onNodeClick).toHaveBeenCalledWith('invoice_sent');
  });

  it('fires onNodeClick with the stage key', async () => {
    const onNodeClick = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={allCan} onNodeClick={onNodeClick} />);
    await userEvent.click(screen.getByRole('button', { name: /on site/i }));
    expect(onNodeClick).toHaveBeenCalledWith('on_site');
  });

  it('does not fire for the node the job is already at', async () => {
    const onNodeClick = vi.fn();
    const onSiteJob = { ...baseJob, on_site_at: '2026-03-02T10:00:00Z', status: 'ON_SITE' };
    render(<JobLifecycleBar job={onSiteJob} financials={undefined} can={allCan} onNodeClick={onNodeClick} />);
    // Clicking the current milestone is a no-op: it would re-stamp the timestamp for nothing,
    // and on Completed it would re-arm the AFTER_JOB_COMPLETED follow-up automation.
    const node = screen.queryByRole('button', { name: /on site/i });
    if (node) { await userEvent.click(node); }
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('allows a BACKWARD click to an earlier milestone', async () => {
    const onNodeClick = vi.fn();
    const doneJob = { ...baseJob, on_site_at: '2026-03-02T10:00:00Z', completed_at: '2026-03-02T14:00:00Z', status: 'COMPLETED' };
    render(<JobLifecycleBar job={doneJob} financials={undefined} can={allCan} onNodeClick={onNodeClick} />);
    await userEvent.click(screen.getByRole('button', { name: /on site/i }));
    expect(onNodeClick).toHaveBeenCalledWith('on_site');
  });

  it('shows Start while started_at and completed_at are both null', async () => {
    const onStartClick = vi.fn();
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={allCan} onStartClick={onStartClick} />);
    await userEvent.click(screen.getByRole('button', { name: /^start$/i }));
    expect(onStartClick).toHaveBeenCalled();
  });

  it('keeps every control clickable on a CANCELLED job — cancellation is not terminal', async () => {
    const onNodeClick = vi.fn();
    const cancelled = { ...baseJob, status: 'CANCELLED', cancelled_at: '2026-03-02T11:00:00Z' };
    render(<JobLifecycleBar job={cancelled} financials={undefined} can={allCan} onNodeClick={onNodeClick} />);
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument(); // the badge still shows
    await userEvent.click(screen.getByRole('button', { name: /on site/i }));
    expect(onNodeClick).toHaveBeenCalledWith('on_site');
  });

  it('disables every control while busy', () => {
    render(<JobLifecycleBar job={baseJob} financials={undefined} can={allCan} onNodeClick={vi.fn()} busy />);
    expect(screen.getByRole('button', { name: /on site/i })).toBeDisabled();
  });
});

/**
 * EstimateStatusMenu - the status pill's dropdown.
 *
 * The contract worth guarding is what is NOT offered: this control routes to the endpoints that
 * already own each transition and never invents one. In particular PENDING is permanently
 * unselectable - it means "customer signed", and a staff-set PENDING would leave signature_data
 * null while approvePublic treats PENDING as already-signed, letting the estimate reach WON
 * unsigned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { EstimateStatusMenu } from '@/components/estimates/EstimateStatusMenu';

const onDraft = vi.fn();
const onSent = vi.fn();
const onWon = vi.fn();
const onDeclined = vi.fn();
const onArchived = vi.fn();

/** The target map a SENT estimate produces for a full-access user. */
const sentTargets = {
  DRAFT: { enabled: true, onSelect: onDraft },
  SENT: { enabled: false, reason: 'Only a signed (Pending) estimate can be moved back to Sent', onSelect: onSent },
  PENDING: { enabled: false, reason: 'Pending is set only when the customer signs the estimate' },
  WON: { enabled: true, onSelect: onWon },
  DECLINED: { enabled: true, onSelect: onDeclined },
  ARCHIVED: { enabled: true, onSelect: onArchived },
};

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /change status/i }));
};

const row = (name: RegExp) => screen.getByRole('menuitem', { name });

// Radix renders menu items as divs, so they carry aria-disabled rather than the `disabled`
// attribute `toBeDisabled()` looks for.
const expectDisabled = (el: HTMLElement) => expect(el).toHaveAttribute('aria-disabled', 'true');
const expectEnabled = (el: HTMLElement) => expect(el).not.toHaveAttribute('aria-disabled', 'true');

beforeEach(() => vi.clearAllMocks());

describe('reachability', () => {
  it('lists every status, with the current one marked and inert', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateStatusMenu status="SENT" targets={sentTargets} />);
    await openMenu(user);

    expect(screen.getAllByRole('menuitem')).toHaveLength(6);
    expectDisabled(row(/current/i));
  });

  it('never offers Pending', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateStatusMenu status="SENT" targets={sentTargets} />);
    await openMenu(user);

    expectDisabled(row(/pending/i));
  });

  it('offers the transitions a sent estimate can actually make', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateStatusMenu status="SENT" targets={sentTargets} />);
    await openMenu(user);

    expectEnabled(row(/draft/i));
    expectEnabled(row(/won/i));
    expectEnabled(row(/declined/i));
    expectEnabled(row(/archived/i));
  });

  it('fires the handler the page supplied for the chosen target', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateStatusMenu status="SENT" targets={sentTargets} />);
    await openMenu(user);
    await user.click(row(/won/i));

    expect(onWon).toHaveBeenCalledTimes(1);
    expect(onDraft).not.toHaveBeenCalled();
  });

  it('disables a target the user lacks permission for, and does not fire it', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateStatusMenu
        status="SENT"
        targets={{
          ...sentTargets,
          WON: { enabled: false, reason: 'You do not have permission to approve estimates', onSelect: onWon },
        }}
      />,
    );
    await openMenu(user);

    const won = row(/won/i);
    expectDisabled(won);
    await user.click(won);
    expect(onWon).not.toHaveBeenCalled();
  });

  it('offers only Sent and Archived from Draft', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateStatusMenu
        status="DRAFT"
        targets={{
          // The page always supplies all six; the fixture does too, so these assertions do not
          // depend on the current-status branch short-circuiting a missing key.
          DRAFT: { enabled: false, reason: 'Current status', onSelect: onDraft },
          SENT: { enabled: true, onSelect: onSent },
          PENDING: { enabled: false },
          WON: { enabled: false, reason: 'Send the estimate before marking it Won', onSelect: onWon },
          DECLINED: { enabled: false, reason: 'Send the estimate before marking it Declined', onSelect: onDeclined },
          ARCHIVED: { enabled: true, onSelect: onArchived },
        }}
      />,
    );
    await openMenu(user);

    expectEnabled(row(/sent/i));
    expectEnabled(row(/archived/i));
    expectDisabled(row(/won/i));
    expectDisabled(row(/declined/i));
  });
});

describe('read-only', () => {
  it('renders a plain pill with no dropdown when terminal or locked', () => {
    renderWithProviders(<EstimateStatusMenu status="WON" readOnly targets={sentTargets} />);
    expect(screen.queryByRole('button', { name: /change status/i })).not.toBeInTheDocument();
    expect(screen.getByText(/won/i)).toBeInTheDocument();
  });
});

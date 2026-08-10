import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadStatusesPage from './LeadStatusesPage';

const mockGet = vi.fn();
const mockPatch = vi.fn();
const mockPost = vi.fn();
vi.mock('@/lib/axios', () => ({
  default: {
    get: (...args: unknown[]) => mockGet(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const OVERRIDES = [
  { status: 'NEW', label: null, sort_order: 0, is_default: true, hidden: false },
  { status: 'CONTACTED', label: null, sort_order: 1, is_default: false, hidden: false },
  { status: 'ESTIMATED', label: null, sort_order: 2, is_default: false, hidden: false },
  { status: 'WON', label: 'Closed Won', sort_order: 3, is_default: false, hidden: false },
  { status: 'LOST', label: null, sort_order: 4, is_default: false, hidden: false },
  { status: 'CANCELLED', label: null, sort_order: 5, is_default: false, hidden: true },
];

beforeEach(() => {
  mockGet.mockReset();
  mockPatch.mockReset();
  mockPost.mockReset();
  mockGet.mockResolvedValue({ data: { lead_status_overrides: OVERRIDES } });
  mockPatch.mockResolvedValue({ data: {} });
  mockPost.mockResolvedValue({ data: {} });
});

describe('LeadStatusesPage', () => {
  it('renders all 6 statuses with their registry label or override', async () => {
    renderWithProviders(<LeadStatusesPage />);

    expect(await screen.findByDisplayValue('Closed Won')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
  });

  it('renaming a status commits on blur with the trimmed label', async () => {
    renderWithProviders(<LeadStatusesPage />);

    const input = await screen.findByPlaceholderText('New');
    fireEvent.change(input, { target: { value: '  Fresh Lead  ' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/lead-status-overrides/NEW', { label: 'Fresh Lead', hidden: undefined }));
  });

  it('clearing the input back to empty clears the override (label: null), not an empty string', async () => {
    renderWithProviders(<LeadStatusesPage />);

    const input = await screen.findByDisplayValue('Closed Won');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/lead-status-overrides/WON', { label: null, hidden: undefined }));
  });

  it('the Default button is disabled for the current default and calls the endpoint for another status', async () => {
    renderWithProviders(<LeadStatusesPage />);

    await screen.findByDisplayValue('Closed Won');
    const defaultButtons = screen.getAllByRole('button', { name: /default/i });
    expect(defaultButtons[0]).toBeDisabled(); // NEW - already the default

    // aria-label uses the registry's own name (Won), not the rename - the label rename affects
    // what's rendered as the badge text, not the row's accessible identity.
    fireEvent.click(screen.getByRole('button', { name: /Make Won the default/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/api/lead-status-overrides/WON/default'));
  });

  it('the hide toggle calls the update endpoint with the flipped hidden value', async () => {
    renderWithProviders(<LeadStatusesPage />);

    await screen.findByDisplayValue('Closed Won');
    fireEvent.click(screen.getByRole('button', { name: /^Hide Won$/i }));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('/api/lead-status-overrides/WON', { label: undefined, hidden: true }));
  });

  it('a currently-hidden status shows an Unhide affordance', async () => {
    renderWithProviders(<LeadStatusesPage />);

    expect(await screen.findByRole('button', { name: /^Unhide Cancelled$/i })).toBeInTheDocument();
  });
});

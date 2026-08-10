/**
 * Regression guard for #514 — Owner field keyboard typeahead auto-assigns wrong user.
 *
 * The old AssigneeSelect wrapped a Radix Select whose closed-trigger typeahead
 * committed the first prefix-matching item on a single keystroke (typing "S"
 * instantly assigned "Sherry Dispatcher", making "Sagiv" unreachable). The fix
 * replaces it with a Popover + search Input combobox that only commits on an
 * explicit item click. These tests lock that behavior in.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { AssigneeSelect } from '@/components/crm/AssigneeSelect';
import { type AssignableUser } from '@/lib/api/users';

const MOCK_USERS: AssignableUser[] = [
  { id: 'sherry', first_name: 'Sherry', last_name: 'Dispatcher', role: 'DISPATCHER', is_active: true, has_login: true, department: null },
  { id: 'sagiv', first_name: 'Sagiv', last_name: 'Peker', role: 'ADMIN', is_active: true, has_login: true, department: null },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
}));

describe('AssigneeSelect (#514 keyboard typeahead)', () => {
  it('does NOT auto-assign anyone on initial render', () => {
    const onChange = vi.fn();
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} eligibleFor="task" />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opens a dropdown listing all matching users when the trigger is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));

    const options = screen.getAllByRole('option');
    const labels = options.map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('Sherry Dispatcher'))).toBe(true);
    expect(labels.some((l) => l.includes('Sagiv Peker'))).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('filters by search text without committing a selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search…'), 'Sa');

    const labels = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.includes('Sagiv Peker'))).toBe(true);
    expect(labels.some((l) => l.includes('Sherry Dispatcher'))).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits exactly once, with the clicked user id, only on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<AssigneeSelect value={null} onChange={onChange} eligibleFor="task" />);

    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByPlaceholderText('Search…'), 'Sa');
    await user.click(screen.getByRole('option', { name: /Sagiv Peker/ }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('sagiv');
  });
});

describe('AssigneeSelect option list scrolling inside a Dialog', () => {
  it('keeps wheel and touchmove events from reaching the document scroll lock', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssigneeSelect value={null} onChange={vi.fn()} eligibleFor="task" />);
    await user.click(screen.getByRole('combobox'));

    const list = screen.getByTestId('assignee-options');
    // react-remove-scroll (used by Dialog) listens on `document` and
    // preventDefault()s any wheel/touchmove outside DialogContent. If either
    // event reaches the document, the list cannot scroll.
    const onDocumentWheel = vi.fn();
    const onDocumentTouchMove = vi.fn();
    document.addEventListener('wheel', onDocumentWheel);
    document.addEventListener('touchmove', onDocumentTouchMove);
    try {
      list.dispatchEvent(new Event('wheel', { bubbles: true, cancelable: true }));
      list.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener('wheel', onDocumentWheel);
      document.removeEventListener('touchmove', onDocumentTouchMove);
    }

    expect(onDocumentWheel).not.toHaveBeenCalled();
    expect(onDocumentTouchMove).not.toHaveBeenCalled();
  });

  it('caps the option list height so it scrolls instead of overflowing the popover', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AssigneeSelect value={null} onChange={vi.fn()} eligibleFor="task" />);
    await user.click(screen.getByRole('combobox'));

    const list = screen.getByTestId('assignee-options');
    expect(list.className).toContain('max-h-60');
    expect(list.className).toContain('overflow-y-auto');
  });
});

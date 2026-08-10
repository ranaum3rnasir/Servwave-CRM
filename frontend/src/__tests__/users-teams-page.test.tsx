import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import UsersTeamsPage from '@/pages/settings/UsersTeamsPage';

const mockApi = vi.mocked(api);

// The page now gates mutation controls on the CASL ability; these flows exercise the admin path.
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const USER = {
  id: 'u1',
  email: 'tess@test.com',
  first_name: 'Tess',
  last_name: 'Tech',
  role: 'TECHNICIAN',
  is_active: true,
  has_login: true,
  phone: '5551112222',
  phone_ext: null,
  department_id: null,
  department: null,
  enforce_clock_in_location: true,
  can_approve_clock_overrides: false,
  created_at: '',
  updated_at: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users') return Promise.resolve({ data: { users: [USER] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    // SRVW-138/139 - the role picker (roleAssignmentOptions) reads this list directly.
    if (url === '/api/roles') {
      return Promise.resolve({
        data: [
          { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 0, type: 'system' },
          { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 0, type: 'system' },
          { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 0, type: 'system' },
          { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 1, type: 'system' },
        ],
      });
    }
    return Promise.resolve({ data: {} });
  });
  mockApi.patch.mockResolvedValue({ data: { user: USER } });
  mockApi.delete.mockResolvedValue({ data: { message: 'User deactivated' } });
});

describe('UsersTeamsPage — admin edit details', () => {
  it('edits a user’s phone via the edit dialog and PATCHes /api/users/:id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const phone = await screen.findByPlaceholderText('Phone');
    await user.clear(phone);
    await user.type(phone, '5559998888');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        '/api/users/u1',
        expect.objectContaining({ phone: '(555) 999-8888', first_name: 'Tess', last_name: 'Tech' }),
      ),
    );
  });
});

describe('UsersTeamsPage — deactivate confirmation', () => {
  it('does not deactivate until the confirm dialog is accepted, and warns login is removed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<UsersTeamsPage />, { ability: ADMIN });
    await screen.findByText('Tess Tech');

    // Opening the row action only shows the dialog — no API call yet.
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(mockApi.delete).not.toHaveBeenCalled();
    expect(screen.getByText(/login removed/i)).toBeInTheDocument();

    // Confirm inside the dialog.
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith('/api/users/u1'));
  });
});

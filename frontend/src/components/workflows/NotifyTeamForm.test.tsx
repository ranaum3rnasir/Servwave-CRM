import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import NotifyTeamForm from './NotifyTeamForm';
import { FORM_CATALOG } from './step-forms.fixture';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import type { AssignableUser } from '@/lib/api/users';

// Mirrors catalog.ts's audiencesFor() for a job trigger's NOTIFY_TEAM action:
// same job audiences minus `customer` (in-app notifications have no customer
// surface) and minus `custom` (email-only). Salesperson keeps its hint.
const CATALOG: WorkflowCatalog = {
  ...FORM_CATALOG,
  audiences: {
    JOB_SCHEDULED: {
      SEND_EMAIL: [],
      SEND_SMS: [{ key: 'customer', label: 'the customer' }],
      NOTIFY_TEAM: [
        { key: 'assigned_team', label: 'the assigned crew', hint: 'Skipped if no one is assigned yet.' },
        { key: 'dispatcher', label: 'the dispatcher', hint: 'Skipped if no dispatcher is set.' },
        { key: 'salesperson', label: 'the salesperson', hint: 'Skipped if no salesperson is set.' },
        { key: 'all_admins', label: 'all admins' },
        { key: 'all_dispatchers', label: 'all dispatchers' },
        { key: 'specific_user', label: 'a specific person' },
      ],
    },
  } as unknown as WorkflowCatalog['audiences'],
};

const MOCK_USERS: AssignableUser[] = [
  { id: 'u1', first_name: 'Ada', last_name: 'Lovelace', role: 'ADMIN', is_active: true, has_login: true, department: null },
  { id: 'u2', first_name: 'Grace', last_name: 'Hopper', role: 'DISPATCHER', is_active: true, has_login: true, department: null },
];

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: MOCK_USERS, isLoading: false })),
}));

function setup(config: Record<string, unknown>) {
  const onChange = vi.fn();
  renderWithProviders(
    <NotifyTeamForm config={config} triggerType="JOB_SCHEDULED" catalog={CATALOG} onChange={onChange} />,
  );
  return { onChange };
}

describe('NotifyTeamForm — legal audiences (no customer, no custom)', () => {
  it('renders the NOTIFY_TEAM audiences the catalog advertises, salesperson hint included', () => {
    setup({ recipient: 'all_admins', body: 'New job' });
    expect(screen.getByRole('checkbox', { name: 'all admins' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'the salesperson' })).toBeInTheDocument();
    expect(screen.getByText('Skipped if no salesperson is set.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'the customer' })).toBeNull();
  });
});

describe('NotifyTeamForm — legacy singular recipient loads ticked', () => {
  it('a legacy { recipient: "all_admins" } config shows all-admins ticked', () => {
    setup({ recipient: 'all_admins', body: 'New job' });
    expect(screen.getByRole('checkbox', { name: 'all admins' })).toBeChecked();
  });

  it('folds the pre-v2.1 assigned_techs alias to assigned_team on load', () => {
    setup({ recipient: 'assigned_techs', body: 'New job' });
    expect(screen.getByRole('checkbox', { name: 'the assigned crew' })).toBeChecked();
  });
});

describe('NotifyTeamForm — multi-select emits the array shape', () => {
  it('ticking two audiences emits recipients: [a, b] alongside body', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'all_admins', body: 'New job' });

    await user.click(screen.getByRole('checkbox', { name: 'the salesperson' }));

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['all_admins', 'salesperson'],
      body: 'New job',
    });
  });

  it('specific_user reveals the multi-pick team-member list; picking two emits user_ids', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'all_admins', body: 'New job' });

    await user.click(screen.getByRole('checkbox', { name: 'a specific person' }));
    expect(screen.getByText('Pick at least one team member')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Ada Lovelace' }));
    await user.click(screen.getByRole('checkbox', { name: 'Grace Hopper' }));

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['all_admins', 'specific_user'],
      body: 'New job',
      user_ids: ['u1', 'u2'],
    });
  });

  it('mirrors a single ticked audience onto legacy `recipient` (bubble/recipe sentence back-compat)', async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ recipient: 'all_admins', body: 'New job' });

    await user.type(screen.getByLabelText('Message'), '!');

    expect(onChange).toHaveBeenLastCalledWith({
      recipients: ['all_admins'],
      recipient: 'all_admins',
      body: 'New job!',
    });
  });
});

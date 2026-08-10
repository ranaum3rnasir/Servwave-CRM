import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';
import type { CommItem } from '@/lib/api/jobCommunications';

const mockApi = vi.mocked(api);
const mockRequestCall = vi.mocked(requestCall);

// Org-level comms access (E5): the composer + "Call customer" render only for
// comms-enabled orgs. Default true so the composer specs exercise the full
// surface; the gating specs flip it off.
const commAccess = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Task B4 — "Call customer" routes through the cross-tab dial handoff into
// the /phone tab, not the legacy in-app GlobalDialer popup.
vi.mock('@/lib/communication/phoneTabHandoff', () => ({
  requestCall: vi.fn(),
}));

// The detail drawer fetches a CallSession + renders the hub CallDetailDrawer
// (CallsView/Dialer graph) — stub it so these specs stay on the tab's wiring.
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({
  EntityCallDrawer: ({ callId, onClose }: { callId: string; onClose: () => void }) => (
    <div data-testid="entity-call-drawer" data-call-id={callId}>
      <button type="button" onClick={onClose}>
        close-drawer
      </button>
    </div>
  ),
}));

// The SMS detail drawer reads the customer's thread — stub it so these specs
// stay on the tab's wiring (text row → drawer keyed by customerId).
vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({
  EntitySmsDrawer: ({ customerId, onClose }: { customerId: string; onClose: () => void }) => (
    <div data-testid="entity-sms-drawer" data-customer-id={customerId}>
      <button type="button" onClick={onClose}>
        close-sms-drawer
      </button>
    </div>
  ),
}));

// Communication ↔ Jobs Slice 1 — the job-page Communication tab renders the
// Variant-A unified timeline from GET /api/jobs/:id/communications and the
// compact composer stamps outgoing texts/emails with this job
// (attach-by-origin).

const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const JOB_NUMBER = 'J00042';
const CUSTOMER_EMAIL = 'daniel@vaultcorp.com';

const ITEMS_FIXTURE: CommItem[] = [
  {
    id: 'call-0000-0000-0000-000000000001',
    channel: 'call',
    direction: 'in',
    who: 'Daniel Cohen',
    title: 'Inbound call · 4m 07s',
    preview: 'Confirmed Thursday 8am. Asked for COI before arrival.',
    at: '2026-06-01T14:32:00.000Z',
    jobId: JOB_ID,
    jobLabel: JOB_NUMBER,
    meta: 'Booked',
  },
  {
    id: 'email-0000-0000-0000-000000000001',
    channel: 'email',
    direction: 'out',
    who: 'Daniel Cohen',
    title: 'Estimate E00012 · Vault corridor re-key',
    preview: '14 cylinders, restricted keyway. Approve to schedule.',
    at: '2026-06-01T15:00:00.000Z',
    jobId: JOB_ID,
    jobLabel: JOB_NUMBER,
    transactional: true,
  },
  {
    id: 'sms-0000-0000-0000-000000000001',
    channel: 'sms',
    direction: 'out',
    who: 'Daniel Cohen',
    title: 'Text message',
    preview: 'Confirming Thursday 8am for the vault corridor re-key.',
    at: '2026-06-01T15:10:00.000Z',
    jobId: JOB_ID,
    jobLabel: JOB_NUMBER,
  },
  {
    // Cold inbound — no job attribution → muted "no job" badge.
    id: 'wa-0000-0000-0000-000000000001',
    channel: 'whatsapp',
    direction: 'in',
    who: 'Daniel Cohen',
    title: 'WhatsApp message',
    preview: 'Also — do you service our Newark branch?',
    at: '2026-06-02T09:30:00.000Z',
  },
];

const CUSTOMER_PHONE = '5551234567';

// The composer needs create:Communication (E5) — the tab itself renders behind
// the page's read gate, so the default spec ability carries both.
const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
]);
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Communication' }]);
// Attribution management (the attach/move/detach menu) gates on update, not create.
const manageAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

function renderTab(
  props: Partial<ComponentProps<typeof JobCommunicationsTab>> = {},
  renderAbility = ability
) {
  return renderWithProviders(
    <JobCommunicationsTab
      jobId={JOB_ID}
      jobNumber={JOB_NUMBER}
      customerId={CUSTOMER_ID}
      customerName="Daniel Cohen"
      customerEmail={CUSTOMER_EMAIL}
      customerPhone={CUSTOMER_PHONE}
      {...props}
    />,
    { ability: renderAbility }
  );
}

describe('JobCommunicationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockResolvedValue({ data: { items: ITEMS_FIXTURE } });
  });

  it('renders the unified timeline with one row per channel', async () => {
    renderTab();

    expect(await screen.findByText('Inbound call · 4m 07s')).toBeInTheDocument();
    expect(screen.getByText('Estimate E00012 · Vault corridor re-key')).toBeInTheDocument();
    expect(screen.getByText('Text message')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp message')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/communications`);
  });

  it('shows job pills for attributed items and "no job" for unattributed ones', async () => {
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    // Three items carry the job label pill; the cold WhatsApp inbound shows "no job".
    expect(screen.getAllByText(JOB_NUMBER)).toHaveLength(3);
    expect(screen.getByText('no job')).toBeInTheDocument();
  });

  it('marks transactional sends with the auto · transactional chip', async () => {
    renderTab();
    await screen.findByText('Estimate E00012 · Vault corridor re-key');

    expect(screen.getByText('auto · transactional')).toBeInTheDocument();
  });

  it('sends a job-stamped text from the composer and clears it on success', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    const textarea = screen.getByPlaceholderText(/text daniel cohen/i);
    await user.type(textarea, 'On our way');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        customerId: CUSTOMER_ID,
        body: 'On our way',
        jobId: JOB_ID,
      })
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('invalidates the customer roll-up after a job-stamped text send', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    const { queryClient } = renderTab();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByText('Inbound call · 4m 07s');

    await user.type(screen.getByPlaceholderText(/text daniel cohen/i), 'On our way');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // ['customer-communications'] is a prefix — it matches every per-customer
    // roll-up query (['customer-communications', customerId]).
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-communications'] })
    );
  });

  it('composes an email from the job: posts to /api/communication/emails with job_id + subject', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    // Flip the channel toggle to Email — subject + body appear.
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.type(screen.getByPlaceholderText(/subject/i), 'COI for Thursday');
    const bodyBox = screen.getByPlaceholderText(/email daniel cohen/i);
    await user.type(bodyBox, 'Attached is the COI you asked for.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/emails', {
        to: CUSTOMER_EMAIL,
        subject: 'COI for Thursday',
        body: ['Attached is the COI you asked for.'],
        job_id: JOB_ID,
      })
    );
    await waitFor(() => expect(bodyBox).toHaveValue(''));
  });

  it('keeps SMS mode unchanged when toggling to Email and back', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Text' }));

    await user.type(screen.getByPlaceholderText(/text daniel cohen/i), 'Running 10 late');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        customerId: CUSTOMER_ID,
        body: 'Running 10 late',
        jobId: JOB_ID,
      })
    );
  });

  it('disables Email mode with a muted hint when the customer has no email', async () => {
    renderTab({ customerEmail: undefined });
    await screen.findByText('Inbound call · 4m 07s');

    expect(screen.getByRole('button', { name: 'Email' })).toBeDisabled();
    expect(screen.getByText(/no email on file/i)).toBeInTheDocument();
  });

  it('shows the empty state when the job has no communication', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });
    renderTab();

    expect(
      await screen.findByText(/no communication on this job yet/i)
    ).toBeInTheDocument();
  });

  // ── E5: composer + call-entry gating ─────────────────────────────────────

  it('hides the composer without org comms access — the tab is a read-only timeline', async () => {
    commAccess.value = false;
    renderTab();

    // Timeline still renders…
    expect(await screen.findByText('Inbound call · 4m 07s')).toBeInTheDocument();
    // …but no composer affordance that would 403 on send.
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/text daniel cohen/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email' })).not.toBeInTheDocument();
  });

  it('hides the composer without create:Communication (read-only user)', async () => {
    renderTab({}, readOnlyAbility);

    expect(await screen.findByText('Inbound call · 4m 07s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/text daniel cohen/i)).not.toBeInTheDocument();
  });

  it('"Call customer" routes into the /phone tab with full job attribution', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByRole('button', { name: /call customer/i }));

    expect(mockRequestCall).toHaveBeenCalledWith(CUSTOMER_PHONE, {
      jobId: JOB_ID,
      jobLabel: JOB_NUMBER,
      customerId: CUSTOMER_ID,
      customerName: 'Daniel Cohen',
    });
  });

  it('hides "Call customer" without org comms access', async () => {
    commAccess.value = false;
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  it('hides "Call customer" without create:Communication', async () => {
    renderTab({}, readOnlyAbility);
    await screen.findByText('Inbound call · 4m 07s');

    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  it('hides "Call customer" when the customer has no phone', async () => {
    renderTab({ customerPhone: undefined });
    await screen.findByText('Inbound call · 4m 07s');

    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
    // The composer still renders — only the call entry needs a phone.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  // ── Row → call detail drawer ─────────────────────────────────────────────

  it('opens the call detail drawer when a call row is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByText('Inbound call · 4m 07s'));

    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'call-0000-0000-0000-000000000001',
    );
  });

  it('closes the call detail drawer', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByText('Inbound call · 4m 07s'));
    expect(screen.getByTestId('entity-call-drawer')).toBeInTheDocument();

    await user.click(screen.getByText('close-drawer'));
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('opens the SMS conversation drawer when a text row is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));

    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-customer-id', CUSTOMER_ID);
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('closes the SMS conversation drawer', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));
    expect(screen.getByTestId('entity-sms-drawer')).toBeInTheDocument();

    await user.click(screen.getByText('close-sms-drawer'));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();
  });

  it('does NOT open a drawer for email/whatsapp rows in this slice', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('WhatsApp message');

    await user.click(screen.getByText('WhatsApp message'));
    await user.click(screen.getByText('Estimate E00012 · Vault corridor re-key'));

    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('call rows are not clickable-to-drawer without org comms access', async () => {
    commAccess.value = false;
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByText('Inbound call · 4m 07s'));
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('text rows are not clickable-to-drawer without org comms access', async () => {
    commAccess.value = false;
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();
  });

  // Email joined call/sms on the per-row reassign seam. All three sibling
  // roll-ups must show it - including this one, where the row's job IS the
  // hosting page's job (a "move or detach", never a self-link).
  it('gives an email row the attach/move/detach menu when gated', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/jobs/${JOB_ID}/communications`) return { data: { items: ITEMS_FIXTURE } };
      if (url === `/api/customers/${CUSTOMER_ID}`) return { data: { customer: { jobs: [] } } };
      return { data: {} };
    });
    renderTab({}, manageAbility);

    const emailRow = (
      await screen.findByText('Estimate E00012 · Vault corridor re-key')
    ).closest('li')!;
    expect(
      within(emailRow).getByTitle(`Attached to ${JOB_NUMBER} — click to move or detach`)
    ).toBeInTheDocument();
  });
});

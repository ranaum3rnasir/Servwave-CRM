// Slice E4-FE (+ verification follow-up) — the Lead page Communication tab reads
// the LEAD union endpoint (GET /api/leads/:id/communications: lead_id-linked ∪
// customer-linked rows) and renders shared CommRows, with the row's own lead
// chip self-link-suppressed. Compose parity with the Job tab: an SMS composer
// (stamps leadId at origin) + a "Call customer" entry, both gated on comms
// access + create:Communication.
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';
import type { CommItem } from '@/lib/api/jobCommunications';

const mockApi = vi.mocked(api);
const mockRequestCall = vi.mocked(requestCall);

// Org-level comms access — the composer + "Call customer" render only for
// comms-enabled orgs. Default true; the gating specs flip it off.
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

// Stub the detail drawer (it lazy-loads the CallsView/Dialer graph) so this spec
// stays on the tab's wiring.
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({
  EntityCallDrawer: ({ callId, onClose }: { callId: string; onClose: () => void }) => (
    <div data-testid="entity-call-drawer" data-call-id={callId}>
      <button type="button" onClick={onClose}>
        close-drawer
      </button>
    </div>
  ),
}));

vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({
  EntitySmsDrawer: ({ customerId, onClose }: { customerId: string; onClose: () => void }) => (
    <div data-testid="entity-sms-drawer" data-customer-id={customerId}>
      <button type="button" onClick={onClose}>
        close-sms-drawer
      </button>
    </div>
  ),
}));

const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
const OTHER_LEAD_ID = 'e0000000-0000-0000-0000-000000000077';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000042';
const LEAD_LABEL = 'L00001';
const CUSTOMER_NAME = 'Doe HVAC';
const CUSTOMER_PHONE = '5551234567';

const ITEMS: CommItem[] = [
  {
    // Lead-only call (the row the customer roll-up used to miss).
    id: 'ca000000-0000-0000-0000-000000000011',
    channel: 'call',
    direction: 'out',
    who: '+12125551042',
    title: 'Outbound call · 1m 01s',
    preview: 'Intro call — walked through the service request.',
    at: '2026-06-01T14:32:00.000Z',
    leadId: LEAD_ID,
    leadLabel: LEAD_LABEL,
    answeredBy: 'Dana Reyes',
  },
  {
    // Customer-linked SMS attributed to a job AND another lead.
    id: 'aa000000-0000-0000-0000-000000000011',
    channel: 'sms',
    direction: 'in',
    who: 'Doe HVAC',
    title: 'Text message',
    preview: 'Thursday works for the walkthrough.',
    at: '2026-06-01T14:40:00.000Z',
    jobId: JOB_ID,
    jobLabel: 'J00042',
    leadId: OTHER_LEAD_ID,
    leadLabel: 'L00077',
  },
];

// Job-attributed email on the lead's customer - the per-row reassign seam now
// covers this channel too, so it is a menu trigger, not a static pill.
const EMAIL_ITEM: CommItem = {
  id: 'ee000000-0000-0000-0000-000000000011',
  channel: 'email',
  direction: 'out',
  who: 'john@doe.com',
  title: 'Estimate E00042 - ready for review',
  preview: 'Hi John, your estimate is ready for review…',
  at: '2026-06-01T14:50:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
};

// The composer + call entry need create:Communication (the tab renders behind
// the page's read gate, so the default spec ability carries both).
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
  props: Partial<ComponentProps<typeof LeadCommunicationsTab>> = {},
  renderAbility = ability
) {
  return renderWithProviders(
    <LeadCommunicationsTab
      leadId={LEAD_ID}
      leadLabel={LEAD_LABEL}
      customerId={CUSTOMER_ID}
      customerName={CUSTOMER_NAME}
      customerPhone={CUSTOMER_PHONE}
      {...props}
    />,
    { ability: renderAbility }
  );
}

describe('LeadCommunicationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockResolvedValue({ data: { items: ITEMS } });
  });

  it('fetches the lead union endpoint and renders the rows (answered-by + chips)', async () => {
    renderTab();

    expect(await screen.findByText('Outbound call · 1m 01s')).toBeInTheDocument();
    expect(screen.getByText('Text message')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(`/api/leads/${LEAD_ID}/communications`);

    // Calls carry the answered-by fragment.
    expect(screen.getByText('· answered by Dana Reyes')).toBeInTheDocument();

    // THIS lead's own chip is plain (self-link suppressed)…
    expect(screen.getByText(LEAD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(LEAD_LABEL).closest('a')).toBeNull();
    // …while another lead's chip and the job pill navigate.
    expect(screen.getByText('L00077').closest('a')).toHaveAttribute(
      'href',
      `/leads/${OTHER_LEAD_ID}`
    );
    expect(screen.getByText('J00042').closest('a')).toHaveAttribute('href', `/jobs/${JOB_ID}`);
  });

  it('sends a lead-stamped text from the composer and clears it on success', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderTab();
    await screen.findByText('Outbound call · 1m 01s');

    const textarea = screen.getByPlaceholderText(/text doe hvac/i);
    await user.type(textarea, 'Thanks — booking you in.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        customerId: CUSTOMER_ID,
        body: 'Thanks — booking you in.',
        leadId: LEAD_ID,
      })
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('"Call customer" routes into the /phone tab with full lead attribution', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Outbound call · 1m 01s');

    await user.click(screen.getByRole('button', { name: /call customer/i }));

    expect(mockRequestCall).toHaveBeenCalledWith(CUSTOMER_PHONE, {
      leadId: LEAD_ID,
      leadLabel: LEAD_LABEL,
      customerId: CUSTOMER_ID,
      customerName: CUSTOMER_NAME,
    });
  });

  it('hides the composer + call without org comms access (read-only timeline)', async () => {
    commAccess.value = false;
    renderTab();

    expect(await screen.findByText('Outbound call · 1m 01s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/text doe hvac/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  it('hides the composer + call for a read-only user (no create:Communication)', async () => {
    renderTab({}, readOnlyAbility);

    expect(await screen.findByText('Outbound call · 1m 01s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  it('hides "Call customer" when the customer has no phone (composer still renders)', async () => {
    renderTab({ customerPhone: undefined });
    await screen.findByText('Outbound call · 1m 01s');

    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('shows the empty state when the lead has no communications', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });
    renderTab();

    expect(
      await screen.findByText('No communication on this lead yet.')
    ).toBeInTheDocument();
  });

  it('opens the call detail drawer when a call row is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Outbound call · 1m 01s');

    await user.click(screen.getByText('Outbound call · 1m 01s'));

    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'ca000000-0000-0000-0000-000000000011',
    );
  });

  it('opens the SMS conversation drawer (keyed by the lead customer) when a text row is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));

    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-customer-id', CUSTOMER_ID);
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('does not make text rows clickable when the lead has no customer', async () => {
    const user = userEvent.setup();
    renderTab({ customerId: undefined });
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();
  });

  // Email joined call/sms on the per-row reassign seam. All three sibling
  // roll-ups must show it; here the customer scope comes from the lead's
  // converted customer, so an unconverted lead correctly keeps a static pill.
  it('gives an email row the attach/move/detach menu when the lead has a customer', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/leads/${LEAD_ID}/communications`)
        return { data: { items: [...ITEMS, EMAIL_ITEM] } };
      if (url === `/api/customers/${CUSTOMER_ID}`) return { data: { customer: { jobs: [] } } };
      return { data: {} };
    });
    renderTab({}, manageAbility);

    const emailRow = (await screen.findByText('Estimate E00042 - ready for review')).closest('li')!;
    expect(
      within(emailRow).getByTitle('Attached to J00042 — click to move or detach')
    ).toBeInTheDocument();
  });

  // Was "keeps the email pill static when the lead has no customer scope". A
  // missing customer no longer kills the control — it switches the picker into
  // search mode, because rows with no customer are exactly the ones that need
  // manual attribution and the API has always accepted it.
  it('keeps the email pill live (search mode) when the lead has no customer scope', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [EMAIL_ITEM] } });
    renderTab({ customerId: undefined }, manageAbility);

    const emailRow = (await screen.findByText('Estimate E00042 - ready for review')).closest('li')!;
    expect(
      within(emailRow).getByTitle('Attached to J00042 — click to move or detach')
    ).toBeInTheDocument();
  });
});

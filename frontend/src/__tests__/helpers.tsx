import { ReactElement } from 'react';
import { render, RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { TooltipProvider as KitTooltipProvider } from '@/ui-kit/components/ui/tooltip';
import type { AppAbility } from '@/lib/ability';

// ─── Test Query Client ────────────────────────────────────
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

// ─── Render with Providers ────────────────────────────────
interface WrapperOptions {
  initialEntries?: string[];
  /**
   * Optional CASL ability. When provided, children are wrapped in AbilityProvider
   * so ability-gated UI (e.g. force-purge, lead delete) can be exercised. When
   * omitted, useAppAbility() resolves to emptyAbility (all .can() === false),
   * matching the default deny-everything posture.
   */
  ability?: AppAbility;
}

export function renderWithProviders(
  ui: ReactElement,
  options?: RenderOptions & WrapperOptions
) {
  const { initialEntries = ['/'], ability, ...renderOptions } = options ?? {};
  const queryClient = createTestQueryClient();

  function Wrapper({ children }: { children: React.ReactNode }) {
    // App.tsx:69 wraps the entire route table in one KitTooltipProvider, so any
    // routed page may render a kit <Tooltip> without providing its own. Mirroring
    // that here keeps the harness honest: without it a page that tooltips
    // anything throws "`Tooltip` must be used within `TooltipProvider`" in the
    // test and works perfectly in the app, which is a harness defect reported as
    // a product one. Same delay as the app so nothing else diverges.
    const tree = (
      <QueryClientProvider client={queryClient}>
        <KitTooltipProvider delayDuration={320}>
          <MemoryRouter initialEntries={initialEntries}>
            {children}
          </MemoryRouter>
        </KitTooltipProvider>
      </QueryClientProvider>
    );
    return ability ? <AbilityProvider ability={ability}>{tree}</AbilityProvider> : tree;
  }

  return {
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
    queryClient,
  };
}

// ─── Fixtures ─────────────────────────────────────────────

export const LEAD_FIXTURE = {
  id: 'e0000000-0000-0000-0000-000000000001',
  lead_number: 'L00001',
  customer_id: 'c0000000-0000-0000-0000-000000000001',
  status: 'NEW',
  service_request: 'AC not cooling',
  job_type: null,
  scheduled_start: null,
  scheduled_end: null,
  service_address_line1: '123 Main St',
  service_address_line2: null,
  service_city: 'Austin',
  service_state: 'TX',
  service_zip: '78701',
  walkthrough_scheduled_at: null,
  walkthrough_completed_at: null,
  walkthrough_notes: null,
  notes: null,
  lost_at: null,
  lost_reason: null,
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-01-15T00:00:00.000Z',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: 'Doe HVAC',
    email: 'john@doe.com',
    phone: '5551234567',
    phone_ext: null,
    service_locations: [
      {
        id: 'l0000000-0000-0000-0000-000000000001',
        address_line1: '123 Main St',
        address_line2: null,
        city: 'Austin',
        state: 'TX',
        zip: '78701',
        is_primary: true,
      },
    ],
  },
  // Scheduler redesign: SINGLE owner (commission_owner) + the M2M owner-mirror row.
  commission_owner: {
    id: '00000000-0000-0000-0000-000000000003',
    first_name: 'Test',
    last_name: 'Sales',
    email: 'sales@test.com',
  },
  lead_assignees: [
    { user_id: '00000000-0000-0000-0000-000000000003', user: { id: '00000000-0000-0000-0000-000000000003', first_name: 'Test', last_name: 'Sales' } },
  ],
  walkthrough_performers: [],
  estimates: [],
  tags: [],
};

export const LEAD_LIST_FIXTURE = {
  leads: [
    {
      id: LEAD_FIXTURE.id,
      status: 'NEW',
      service_request: 'AC not cooling',
      job_type: null,
      scheduled_start: null,
      created_at: '2026-01-15T00:00:00.000Z',
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Doe HVAC',
        phone: '5551234567',
        ad_source: null,
      },
      commission_owner: {
        id: '00000000-0000-0000-0000-000000000003',
        first_name: 'Test',
        last_name: 'Sales',
      },
      lead_assignees: [
        { user: { id: '00000000-0000-0000-0000-000000000003', first_name: 'Test', last_name: 'Sales' } },
      ],
      walkthrough_performers: [],
      tags: [],
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: {
    total: 10,
    new_this_week: 3,
    unassigned: 1,
    won: 4,
    lost: 2,
  },
};

export const NOTES_FIXTURE = [
  {
    id: 'n0000000-0000-0000-0000-000000000001',
    content: 'Follow up with customer.',
    created_at: '2026-02-18T10:00:00.000Z',
    creator: { id: '00000000-0000-0000-0000-000000000001', first_name: 'Test', last_name: 'Admin' },
  },
];

export const TAGS_FIXTURE = [
  { id: 'a0000000-0000-0000-0000-000000000001', name: 'Urgent', color: '#EF4444' },
  { id: 'a0000000-0000-0000-0000-000000000002', name: 'VIP', color: '#8B5CF6' },
];

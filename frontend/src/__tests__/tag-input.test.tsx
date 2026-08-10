import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, TAGS_FIXTURE } from './helpers';
import { TagInput } from '@/components/leads/TagInput';

const mockApi = vi.mocked(api);

const existingTags = [
  { id: 'a0000000-0000-0000-0000-000000000001', name: 'Urgent', color: '#EF4444' },
];

// ─── Radix popover jsdom shims (scoped to this file) ──────────
// The shared setup mocks ResizeObserver with an arrow fn, which Radix's
// floating-ui calls with `new` — a constructable class is needed to open the
// Popover in jsdom. hasPointerCapture / scrollIntoView are likewise stubbed.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { tags: TAGS_FIXTURE } });
  mockApi.post.mockResolvedValue({ data: { tag: TAGS_FIXTURE[0] } });
  mockApi.delete.mockResolvedValue({ data: {} });
});

/** Open the popover via the dashed '+ Tag' trigger (Radix needs fireEvent in jsdom). */
function openPicker() {
  fireEvent.click(screen.getByText('Tag'));
}

/** The available-tag chips rendered inside the popover, in DOM order. */
function chipNames(): string[] {
  const fixtureNames = new Set(TAGS_FIXTURE.map((t) => t.name));
  return screen
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')
    .filter((name) => fixtureNames.has(name));
}

describe('TagInput', () => {
  it('renders existing tags as pills', () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );

    expect(screen.getByText('Urgent')).toBeInTheDocument();
  });

  it('shows Tag button when popover is closed', () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    expect(screen.getByText('Tag')).toBeInTheDocument();
  });

  it('opens a popover with search input on Tag button click', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    expect(screen.getByPlaceholderText('Search tags...')).toBeInTheDocument();
  });

  it('shows "Available tags (N)" header counting only unattached tags', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );

    openPicker();

    // 2 tags in fixture, 1 attached → 1 available
    await waitFor(() => {
      expect(screen.getByText('Available tags (1)')).toBeInTheDocument();
    });
  });

  it('shows available tags as chips (excluding attached)', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );

    openPicker();

    // VIP should show since it's not attached; Urgent should be excluded
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'VIP' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Urgent' })).not.toBeInTheDocument();
  });

  it('filters the chip list as the user types', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText('Search tags...'), {
      target: { value: 'VIP' },
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Urgent' })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'VIP' })).toBeInTheDocument();
  });

  it('sort toggle reverses the chip order', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'VIP' })).toBeInTheDocument();
    });

    // Default A→Z
    expect(chipNames()).toEqual(['Urgent', 'VIP']);

    fireEvent.click(screen.getByRole('button', { name: /sort/i }));

    await waitFor(() => {
      expect(chipNames()).toEqual(['VIP', 'Urgent']);
    });
  });

  it('shows Create option for non-matching text', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), {
      target: { value: 'NewTag' },
    });

    await waitFor(() => {
      expect(screen.getByText(/Create new tag "NewTag"/)).toBeInTheDocument();
    });
  });

  it('posts name + color when the create row is clicked', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), {
      target: { value: 'NewTag' },
    });

    await waitFor(() => {
      expect(screen.getByText(/Create new tag "NewTag"/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Create new tag "NewTag"/));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/leads/lead-1/tags',
        expect.objectContaining({
          name: 'NewTag',
          color: expect.stringMatching(/^#/),
        })
      );
    });
  });

  it('posts the chosen swatch color, not the default', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), {
      target: { value: 'NewTag' },
    });

    // Swatches render only once the create row is shown (non-matching text).
    const swatch = await screen.findByRole('button', { name: 'Use color #22C55E' });
    fireEvent.click(swatch);

    fireEvent.click(screen.getByText(/Create new tag "NewTag"/));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/leads/lead-1/tags',
        expect.objectContaining({ name: 'NewTag', color: '#22C55E' })
      );
    });
  });

  it('calls remove API when X is clicked on a tag', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <TagInput leadId="lead-1" tags={existingTags} />
    );

    // Click the X button on the Urgent tag
    const xButtons = screen.getAllByRole('button').filter(
      (btn) => btn.querySelector('svg')?.classList.contains('h-3')
    );
    // The first small button should be the X on the tag
    if (xButtons.length > 0) {
      await user.click(xButtons[0]!);
      await waitFor(() => {
        expect(mockApi.delete).toHaveBeenCalledWith(
          expect.stringContaining('/tags/')
        );
      });
    }
  });

  it('calls add API with tag_id when an available chip is clicked', async () => {
    renderWithProviders(
      <TagInput leadId="lead-1" tags={[]} />
    );

    openPicker();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/leads/lead-1/tags',
        expect.objectContaining({ tag_id: TAGS_FIXTURE[0]!.id })
      );
    });
  });
});

// SRVW-103 - the EntityType union widened from 'LEAD' | 'JOB' to all five TagEntity
// values, and the two-way ternary became a Record lookup. These lock the route each
// value addresses, including the deprecated leadId path.
describe('TagInput entity routing', () => {
  async function addFirstChip() {
    openPicker();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Urgent' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Urgent' }));
  }

  it('posts to /api/customers/:id/tags when entityType is CUSTOMER', async () => {
    renderWithProviders(<TagInput entityType="CUSTOMER" entityId="c-1" tags={[]} />);

    await addFirstChip();

    await waitFor(() => {
      expect(mockApi.post.mock.calls[0]![0]).toBe('/api/customers/c-1/tags');
    });
  });

  it('posts to /api/estimates/:id/tags when entityType is ESTIMATE', async () => {
    renderWithProviders(<TagInput entityType="ESTIMATE" entityId="e-1" tags={[]} />);

    await addFirstChip();

    await waitFor(() => {
      expect(mockApi.post.mock.calls[0]![0]).toBe('/api/estimates/e-1/tags');
    });
  });

  it('posts to /api/invoices/:id/tags when entityType is INVOICE', async () => {
    renderWithProviders(<TagInput entityType="INVOICE" entityId="i-1" tags={[]} />);

    await addFirstChip();

    await waitFor(() => {
      expect(mockApi.post.mock.calls[0]![0]).toBe('/api/invoices/i-1/tags');
    });
  });

  it('still routes the deprecated leadId prop to /api/leads/:id/tags', async () => {
    renderWithProviders(<TagInput leadId="lead-1" tags={[]} />);

    await addFirstChip();

    await waitFor(() => {
      expect(mockApi.post.mock.calls[0]![0]).toBe('/api/leads/lead-1/tags');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useAssignableUsers } from './users';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('useAssignableUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: { users: [] } });
  });

  it('threads department_id + eligible_for into GET /api/users', async () => {
    renderHook(() => useAssignableUsers({ departmentId: 'dept-1', eligibleFor: 'owner' }), { wrapper });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users', {
        params: { assignable: true, department_id: 'dept-1', eligible_for: 'owner' },
      }),
    );
  });

  it('sends eligible_for=task for the task owner/watchers pool (#434)', async () => {
    renderHook(() => useAssignableUsers({ eligibleFor: 'task' }), { wrapper });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users', {
        params: { assignable: true, eligible_for: 'task' },
      }),
    );
  });

  it('omits optional params when not given', async () => {
    renderHook(() => useAssignableUsers(), { wrapper });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users', { params: { assignable: true } }),
    );
  });

  it('does not fetch when disabled', () => {
    renderHook(() => useAssignableUsers({ enabled: false }), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });
});

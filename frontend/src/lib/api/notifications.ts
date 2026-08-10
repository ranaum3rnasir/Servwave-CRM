import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import api from '@/lib/axios';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  verb: string;
  category: string;
  priority: 'INTERRUPT' | 'FEED';
  needs_action: boolean;
  title: string;
  body: string | null;
  object_type: string;
  object_id: string;
  object_label: string | null;
  action_type: string | null;
  data: Record<string, unknown>;
  created_at: string;
  seen_at: string | null;
  read_at: string | null;
  acted_at: string | null;
}

export interface NotificationListResponse {
  items: NotificationView[];
  nextCursor: string | null;
}

export interface UnreadCountResponse {
  unseen: number;
  needs_action: number;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_KEY = ['notifications'] as const;
export const NOTIFICATIONS_UNREAD_COUNT_KEY = ['notifications', 'unread-count'] as const;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useNotifications({ needsAction }: { needsAction?: boolean } = {}) {
  return useInfiniteQuery<NotificationListResponse, Error, InfiniteData<NotificationListResponse>, readonly ['notifications', { needsAction: boolean }], string | undefined>({
    queryKey: [...NOTIFICATIONS_KEY, { needsAction: needsAction ?? false }] as const,
    queryFn: ({ pageParam }) =>
      api
        .get('/api/notifications', {
          params: {
            ...(needsAction !== undefined ? { needs_action: needsAction } : undefined),
            ...(pageParam !== undefined ? { cursor: pageParam } : undefined),
          },
        })
        .then((r) => r.data),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useUnreadCount() {
  return useQuery<UnreadCountResponse>({
    queryKey: NOTIFICATIONS_UNREAD_COUNT_KEY,
    queryFn: () => api.get('/api/notifications/unread-count').then((r) => r.data),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

// ---------------------------------------------------------------------------
// Mutations — all invalidate the ['notifications'] prefix on success
// ---------------------------------------------------------------------------

export function useMarkSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) =>
      api.patch('/api/notifications/seen', ids ? { ids } : {}).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch(`/api/notifications/${id}/read`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useReadAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/notifications/read-all').then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useMarkActed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch(`/api/notifications/${id}/act`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useDismiss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.patch(`/api/notifications/${id}/dismiss`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

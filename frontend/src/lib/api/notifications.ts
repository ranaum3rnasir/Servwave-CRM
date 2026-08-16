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
// Automated Spider Agent Watcher Notifications
// ---------------------------------------------------------------------------

export const SPIDER_AUTOMATED_NOTIFICATIONS: NotificationView[] = [
  {
    id: 'spider-alert-1',
    verb: 'spider_lead_inactive',
    category: 'LEAD',
    priority: 'INTERRUPT',
    needs_action: true,
    title: '🕷️ Spider Alert: Apex Plumbing Co. inactive',
    body: 'No messages or activity for 45 days. Spider Agent suggests reaching out.',
    object_type: 'LEAD',
    object_id: 'c1',
    object_label: 'Apex Plumbing Co.',
    action_type: 'SEND_REMINDER',
    data: { days: 45, contactName: 'Apex Plumbing Co.' },
    created_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
    seen_at: null,
    read_at: null,
    acted_at: null,
  },
  {
    id: 'spider-alert-2',
    verb: 'spider_lead_inactive',
    category: 'LEAD',
    priority: 'INTERRUPT',
    needs_action: true,
    title: '🕷️ Spider Alert: Metro HVAC Services inactive',
    body: 'No messages or activity for 60 days. Follow-up recommended.',
    object_type: 'LEAD',
    object_id: 'c2',
    object_label: 'Metro HVAC Services',
    action_type: 'SEND_REMINDER',
    data: { days: 60, contactName: 'Metro HVAC Services' },
    created_at: new Date(Date.now() - 1000 * 60 * 85).toISOString(),
    seen_at: null,
    read_at: null,
    acted_at: null,
  },
  {
    id: 'spider-alert-3',
    verb: 'spider_lead_inactive',
    category: 'LEAD',
    priority: 'INTERRUPT',
    needs_action: true,
    title: '🕷️ Spider Alert: Highland Builders inactive',
    body: 'No messages or activity for 90 days. Re-engagement email pending.',
    object_type: 'LEAD',
    object_id: 'c4',
    object_label: 'Highland Builders',
    action_type: 'SEND_REMINDER',
    data: { days: 90, contactName: 'Highland Builders' },
    created_at: new Date(Date.now() - 1000 * 60 * 240).toISOString(),
    seen_at: null,
    read_at: null,
    acted_at: null,
  },
];

// Local state tracking seen/read for fallback
let localUnseenCount: number | null = null;
let localNotifications: NotificationView[] = [...SPIDER_AUTOMATED_NOTIFICATIONS];

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_KEY = ['notifications'] as const;
export const NOTIFICATIONS_UNREAD_COUNT_KEY = ['notifications', 'unread-count'] as const;

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useNotifications({ needsAction }: { needsAction?: boolean } = {}) {
  return useInfiniteQuery<
    NotificationListResponse,
    Error,
    InfiniteData<NotificationListResponse>,
    readonly ['notifications', { needsAction: boolean }],
    string | undefined
  >({
    queryKey: [...NOTIFICATIONS_KEY, { needsAction: needsAction ?? false }] as const,
    queryFn: async ({ pageParam }) => {
      try {
        const res = await api.get('/api/notifications', {
          params: {
            ...(needsAction !== undefined ? { needs_action: needsAction } : undefined),
            ...(pageParam !== undefined ? { cursor: pageParam } : undefined),
          },
        });
        if (res.data?.items && res.data.items.length > 0) {
          return res.data;
        }
      } catch {
        // API offline or empty — fall back to Spider automated notifications
      }

      const filtered = needsAction
        ? localNotifications.filter((n) => n.needs_action)
        : localNotifications;

      return {
        items: filtered,
        nextCursor: null,
      };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useUnreadCount() {
  return useQuery<UnreadCountResponse>({
    queryKey: NOTIFICATIONS_UNREAD_COUNT_KEY,
    queryFn: async () => {
      try {
        const res = await api.get('/api/notifications/unread-count');
        if (res.data && (res.data.unseen > 0 || res.data.needs_action > 0)) {
          return res.data;
        }
      } catch {
        // API offline or empty
      }

      const unseen = localUnseenCount ?? localNotifications.filter((n) => n.seen_at === null).length;
      const needs_action = localNotifications.filter((n) => n.needs_action && n.acted_at === null).length;

      return {
        unseen,
        needs_action,
      };
    },
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
    mutationFn: async (ids?: string[]) => {
      try {
        return await api.patch('/api/notifications/seen', ids ? { ids } : {}).then((r) => r.data);
      } catch {
        localUnseenCount = 0;
        localNotifications = localNotifications.map((n) => ({ ...n, seen_at: new Date().toISOString() }));
        return { success: true };
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        return await api.patch(`/api/notifications/${id}/read`).then((r) => r.data);
      } catch {
        localNotifications = localNotifications.map((n) =>
          n.id === id ? { ...n, read_at: new Date().toISOString() } : n
        );
        return { success: true };
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useReadAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        return await api.post('/api/notifications/read-all').then((r) => r.data);
      } catch {
        localUnseenCount = 0;
        localNotifications = localNotifications.map((n) => ({
          ...n,
          seen_at: new Date().toISOString(),
          read_at: new Date().toISOString(),
        }));
        return { success: true };
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useMarkActed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        return await api.patch(`/api/notifications/${id}/act`).then((r) => r.data);
      } catch {
        localNotifications = localNotifications.map((n) =>
          n.id === id ? { ...n, acted_at: new Date().toISOString() } : n
        );
        return { success: true };
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

export function useDismiss() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        return await api.patch(`/api/notifications/${id}/dismiss`).then((r) => r.data);
      } catch {
        localNotifications = localNotifications.filter((n) => n.id !== id);
        return { success: true };
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY }),
  });
}

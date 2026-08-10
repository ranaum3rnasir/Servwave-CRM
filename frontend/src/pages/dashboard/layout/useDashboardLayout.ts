import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import type { DashboardLayout, LayoutItem } from './types';
import { DEFAULT_LAYOUT } from './defaultLayout';

const KEY = (uid: string) => `alpha:dashboard-layout:v1:${uid}`;

/** Per-user dashboard layout, persisted to localStorage. The hook is the seam:
 * swap to a backend store later without touching components. */
export function useDashboardLayout() {
  const userId = useAuthStore((s) => s.user?.id) ?? 'anon';
  const [layout, setLayout] = useState<DashboardLayout>(DEFAULT_LAYOUT);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY(userId));
      const saved: DashboardLayout = raw ? (JSON.parse(raw) as DashboardLayout) : DEFAULT_LAYOUT;
      // keep saved order/visibility, append any new default widgets not yet present
      const savedIds = new Set(saved.map((i) => i.id));
      const merged = [...saved, ...DEFAULT_LAYOUT.filter((i) => !savedIds.has(i.id))];
      setLayout(merged);
    } catch {
      setLayout(DEFAULT_LAYOUT);
    }
  }, [userId]);

  const persist = useCallback(
    (next: DashboardLayout) => {
      setLayout(next);
      try {
        localStorage.setItem(KEY(userId), JSON.stringify(next));
      } catch {
        /* ignore quota / disabled storage */
      }
    },
    [userId],
  );

  const update = useCallback(
    (id: string, patch: Partial<LayoutItem>) => persist(layout.map((i) => (i.id === id ? { ...i, ...patch } : i))),
    [layout, persist],
  );

  const reorder = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const arr = [...layout];
      const from = arr.findIndex((i) => i.id === fromId);
      const to = arr.findIndex((i) => i.id === toId);
      if (from < 0 || to < 0) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved!);
      persist(arr);
    },
    [layout, persist],
  );

  const add = useCallback(
    (id: string) => {
      if (layout.some((i) => i.id === id)) {
        persist(layout.map((i) => (i.id === id ? { ...i, visible: true } : i)));
      } else {
        persist([...layout, { id, visible: true }]);
      }
    },
    [layout, persist],
  );

  const reset = useCallback(() => persist(DEFAULT_LAYOUT), [persist]);

  return { layout, update, reorder, add, reset };
}

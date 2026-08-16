import { create } from 'zustand';

export interface SpiderNotificationsConfig {
  email: boolean;
  sms: boolean;
  inApp: boolean;
}

interface SpiderWatcherState {
  notifications: SpiderNotificationsConfig;
  days: string;
  setNotifications: (updater: SpiderNotificationsConfig | ((prev: SpiderNotificationsConfig) => SpiderNotificationsConfig)) => void;
  setInAppNotification: (enabled: boolean) => void;
  setDays: (days: string) => void;
}

export const useSpiderWatcherStore = create<SpiderWatcherState>((set) => ({
  notifications: {
    email: true,
    sms: true,
    inApp: true, // enabled by default
  },
  days: '3',
  setNotifications: (updater) =>
    set((state) => ({
      notifications: typeof updater === 'function' ? updater(state.notifications) : updater,
    })),
  setInAppNotification: (enabled) =>
    set((state) => ({
      notifications: { ...state.notifications, inApp: enabled },
    })),
  setDays: (days) => set({ days }),
}));

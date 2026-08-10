import { create } from 'zustand';

interface TaskDetailState {
  openTaskId: string | null;
  open: (id: string) => void;
  close: () => void;
}

export const useTaskDetailStore = create<TaskDetailState>((set) => ({
  openTaskId: null,
  open: (id) => set({ openTaskId: id }),
  close: () => set({ openTaskId: null }),
}));

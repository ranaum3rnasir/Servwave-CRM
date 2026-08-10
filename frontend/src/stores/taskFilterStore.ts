import { create } from 'zustand';
import type { TaskFilter, TaskCategory } from '@/lib/tasks/tasks-logic';

interface TaskFilterState extends TaskFilter {
  // Re-declared required (inherited optional on TaskFilter; store always holds concrete values)
  overdue: boolean;
  atRisk: boolean;
  dueFrom: string;
  dueTo: string;
  createdFrom: string;
  createdTo: string;
  setMember: (id: string) => void;
  setDepartment: (id: string) => void;
  setTag: (tag: string) => void;
  setCategory: (category: TaskCategory) => void;
  setOverdue: (v: boolean) => void;
  setAtRisk: (v: boolean) => void;
  setDueRange: (r: { from: string; to: string }) => void;
  setCreatedRange: (r: { from: string; to: string }) => void;
  reset: () => void;
}

export const useTaskFilterStore = create<TaskFilterState>((set) => ({
  memberId: 'all',
  departmentId: 'all',
  tag: 'all',
  category: 'all',
  overdue: false,
  atRisk: false,
  dueFrom: '',
  dueTo: '',
  createdFrom: '',
  createdTo: '',
  setMember: (memberId) => set({ memberId }),
  setDepartment: (departmentId) => set({ departmentId }),
  setTag: (tag) => set({ tag }),
  setCategory: (category) => set({ category }),
  setOverdue: (overdue) => set({ overdue }),
  setAtRisk: (atRisk) => set({ atRisk }),
  setDueRange: ({ from, to }) => set({ dueFrom: from, dueTo: to }),
  setCreatedRange: ({ from, to }) => set({ createdFrom: from, createdTo: to }),
  reset: () => set({
    memberId: 'all', departmentId: 'all', tag: 'all', category: 'all',
    overdue: false, atRisk: false,
    dueFrom: '', dueTo: '', createdFrom: '', createdTo: '',
  }),
}));

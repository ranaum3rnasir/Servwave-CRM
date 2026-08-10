/**
 * FE-6: TaskDetailDrawer rich mutations
 * Tests that drawer wires fetch-on-open, subtask CRUD, comment composer,
 * nudge button, and watcher management to real store actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { TaskDetailDrawer } from '@/components/tasks/TaskDetailDrawer';

// ── Store mocks ────────────────────────────────────────────────────────────────

const mockFetchTaskDetail = vi.fn().mockResolvedValue(undefined);
const mockAddComment = vi.fn().mockResolvedValue(undefined);
const mockAddSubtask = vi.fn().mockResolvedValue(undefined);
const mockToggleSubtask = vi.fn().mockResolvedValue(undefined);
const mockDeleteSubtask = vi.fn().mockResolvedValue(undefined);
const mockSetWatchers = vi.fn().mockResolvedValue(undefined);
const mockNudge = vi.fn().mockResolvedValue(undefined);
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockUpdateStatus = vi.fn().mockResolvedValue(undefined);

// Default task object used in most tests
const TASK = {
  id: 't1',
  task_number: 'T00001',
  title: 'Fix the valve',
  description: 'Needs attention',
  status: 'TODO' as const,
  priority: 'HIGH' as const,
  owner_id: 'u1',
  owner_name: 'Oved Adani',
  watcher_ids: ['u2'],
  watchers: [{ id: 'u2', name: 'Priya' }],
  due_at: null,
  linked_entity: null,
  tags: [],
  subtasks: [{ id: 's1', text: 'Order parts', done: false }],
  comments: [{ id: 'c1', author_id: 'u1', author_name: 'Oved', body: 'In progress', at: '2026-06-17T10:00:00Z' }],
  activity: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' as const },
  created_by: 'u1',
  created_at: '2026-06-17T00:00:00Z',
  updated_at: '2026-06-17T00:00:00Z',
  completed_at: null,
};

// Mutable tasks list so per-test overrides work without re-mocking the module
let mockTasks = [TASK as typeof TASK & { created_by_name?: string | null }];

vi.mock('@/stores/tasksStore', () => ({
  useTasksStore: () => ({
    tasks: mockTasks,
    fetchTaskDetail: mockFetchTaskDetail,
    addComment: mockAddComment,
    addSubtask: mockAddSubtask,
    toggleSubtask: mockToggleSubtask,
    deleteSubtask: mockDeleteSubtask,
    setWatchers: mockSetWatchers,
    nudge: mockNudge,
    updateTask: mockUpdateTask,
    updateStatus: mockUpdateStatus,
  }),
}));

// taskDetailStore: open t1 by default
vi.mock('@/stores/taskDetailStore', () => {
  const { create } = require('zustand');
  const store = create(() => ({ openTaskId: 't1', open: vi.fn(), close: vi.fn() }));
  return { useTaskDetailStore: store };
});

// AssigneeSelect: lightweight stub — clicking fires onChange with 'u3'
vi.mock('@/components/crm/AssigneeSelect', () => ({
  AssigneeSelect: ({ onChange }: { onChange: (id: string | null) => void }) => (
    <button data-testid="assignee-select" onClick={() => onChange('u3')}>
      Change Owner
    </button>
  ),
}));

// MultiAssigneeSelect: stub — clicking fires onChange with []
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({
    value,
    onChange,
  }: {
    value: string[];
    onChange: (ids: string[]) => void;
  }) => (
    <button data-testid="multi-assignee-select" onClick={() => onChange([])}>
      {`Watchers: ${value.join(',')}`}
    </button>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks = [TASK]; // reset to default fixture
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TaskDetailDrawer FE-6 rich mutations', () => {
  it('calls fetchTaskDetail when the drawer opens (openTaskId changes)', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(mockFetchTaskDetail).toHaveBeenCalledWith('t1');
  });

  it('renders the task title in the drawer', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByDisplayValue('Fix the valve')).toBeInTheDocument();
  });

  it('restricts the Due time list to 15-minute increments (#416)', async () => {
    // The Due field is a DateTimePicker (DatePicker + TimeCombobox); the time list is
    // generated every stepMinutes (default 15), so only :00/:15/:30/:45 appear.
    const user = userEvent.setup();
    renderWithProviders(<TaskDetailDrawer />);
    const timeInput = screen.getByPlaceholderText('Time');
    await user.click(timeInput);
    const options = await screen.findAllByRole('button', { name: /\d{1,2}:\d{2} (AM|PM)/ });
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o.textContent ?? '').toMatch(/:(00|15|30|45)\s*(AM|PM)$/);
  });

  // ── Subtasks ───────────────────────────────────────────────────────────────

  it('renders existing subtask with checkbox + delete button', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByText('Order parts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete subtask/i })).toBeInTheDocument();
  });

  it('toggleSubtask is called when a subtask checkbox is clicked', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const checkbox = screen.getByRole('checkbox');
    await userEvent.click(checkbox);
    expect(mockToggleSubtask).toHaveBeenCalledWith('t1', 's1', true);
  });

  it('deleteSubtask is called when the subtask delete button is clicked', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const deleteBtn = screen.getByRole('button', { name: /delete subtask/i });
    await userEvent.click(deleteBtn);
    expect(mockDeleteSubtask).toHaveBeenCalledWith('t1', 's1');
  });

  it('addSubtask is called when a new subtask is submitted', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const input = screen.getByPlaceholderText(/add subtask/i);
    await userEvent.type(input, 'Buy copper fittings');
    const addBtn = screen.getByRole('button', { name: /add subtask/i });
    await userEvent.click(addBtn);
    expect(mockAddSubtask).toHaveBeenCalledWith('t1', 'Buy copper fittings');
  });

  it('addSubtask can also be triggered by pressing Enter in the subtask input', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const input = screen.getByPlaceholderText(/add subtask/i);
    await userEvent.type(input, 'Test{Enter}');
    expect(mockAddSubtask).toHaveBeenCalledWith('t1', 'Test');
  });

  // ── Comments ───────────────────────────────────────────────────────────────

  it('renders existing comment body', () => {
    renderWithProviders(<TaskDetailDrawer />);
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('addComment is called when the Post button is clicked', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'Looks good');
    await userEvent.click(screen.getByRole('button', { name: /^post$/i }));
    expect(mockAddComment).toHaveBeenCalledWith('t1', 'Looks good');
  });

  it('clears the comment textarea after successful post', async () => {
    mockAddComment.mockResolvedValue(undefined);
    renderWithProviders(<TaskDetailDrawer />);
    const textarea = screen.getByPlaceholderText(/add a comment/i);
    await userEvent.type(textarea, 'Nice work');
    await userEvent.click(screen.getByRole('button', { name: /^post$/i }));
    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('does not call addComment when textarea is empty', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    await userEvent.click(screen.getByRole('button', { name: /^post$/i }));
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  // ── Nudge ─────────────────────────────────────────────────────────────────

  it('nudge is called when the Nudge button is clicked', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    await userEvent.click(screen.getByRole('button', { name: /nudge/i }));
    expect(mockNudge).toHaveBeenCalledWith('t1');
  });

  // ── Watchers ──────────────────────────────────────────────────────────────

  it('renders MultiAssigneeSelect for watchers with current watcher_ids', () => {
    renderWithProviders(<TaskDetailDrawer />);
    const watcherWidget = screen.getByTestId('multi-assignee-select');
    expect(watcherWidget).toBeInTheDocument();
    expect(watcherWidget.textContent).toContain('u2');
  });

  it('setWatchers is called when watchers change', async () => {
    renderWithProviders(<TaskDetailDrawer />);
    const watcherWidget = screen.getByTestId('multi-assignee-select');
    await userEvent.click(watcherWidget);
    expect(mockSetWatchers).toHaveBeenCalledWith('t1', []);
  });

  // ── QA-Fix-4b: created_by_name ─────────────────────────────────────────────

  it('renders created_by_name when present (not the raw UUID)', () => {
    // Swap tasks list to include created_by_name before render
    mockTasks = [{ ...TASK, created_by_name: 'Oved Adani' }];
    renderWithProviders(<TaskDetailDrawer />);
    // "Created by" row should show the name, not the raw id
    expect(screen.getByText('Oved Adani')).toBeInTheDocument();
  });

  it('falls back to created_by UUID when created_by_name is absent', () => {
    renderWithProviders(<TaskDetailDrawer />);
    // TASK fixture has created_by: 'u1', no created_by_name
    expect(screen.getByText('u1')).toBeInTheDocument();
  });
});

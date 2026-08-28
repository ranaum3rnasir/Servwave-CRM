import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/patterns/FormField';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { type ParsedTask } from '@/lib/tasks/taskAI';
import { TASK_PRIORITIES, type LinkedEntity } from '@/lib/tasks/types';
import { LinkedEntitySelect } from './LinkedEntitySelect';
import { useTasksStore } from '@/stores/tasksStore';
import { useToast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { useTaskAssignPermission } from '@/lib/tasks/useTaskAssignPermission';
import { useLinkedEntityAccess, useTaskRosterEditable } from '@/lib/tasks/useLinkedEntityAccess';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { useScheduleTimezone, pickerValueToIso, isoToPickerValue } from '@/lib/schedule-tz';
import { SelectField } from '@/components/form/SelectField';

interface CreateTaskModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialParse?: ParsedTask | null;
  presetEntity?: LinkedEntity | null; // when opened from a Job/Lead (Task 19); locks linked entity
}

export function CreateTaskModal({ open, onOpenChange, initialParse, presetEntity }: CreateTaskModalProps) {
  // Task due times mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();

  const addTask = useTasksStore((s) => s.addTask);
  const { toast } = useToast();
  // CASL `assign` on Task, never `role === 'ADMIN'` - see the hook's note.
  const { canAssignOthers, actorId } = useTaskAssignPermission();

  /**
   * A user WITHOUT `assign` can only ever create a task on themselves - the
   * server forces `[actorId]` and 403s anything else - so their disabled field
   * shows that outcome instead of an empty control that lies about what will
   * happen. A holder starts blank and picks.
   *
   * useCallback so the open-effect can depend on it honestly: the grant and the
   * actor arrive with the session, and a dialog opened before they land must
   * re-seed once they do rather than keeping a stale empty array.
   */
  const seedAssignees = useCallback((parsed?: string): string[] => {
    if (!canAssignOthers) return actorId ? [actorId] : [];
    return parsed ? [parsed] : [];
  }, [canAssignOthers, actorId]);

  // Structured form state
  const [title, setTitle] = useState('');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [watcherIds, setWatcherIds] = useState<string[]>([]);
  const [dueDatetimeLocal, setDueDatetimeLocal] = useState('');
  const [priority, setPriority] = useState<string>('MEDIUM');
  const [linkedEntity, setLinkedEntity] = useState<LinkedEntity | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const effectiveEntity = presetEntity ?? linkedEntity;
  // Null while the modal is shut, so the roster check costs one request per OPENING rather than
  // one per mount of the tasks tab, which always presets its entity, and null for a reader who
  // can change neither roster, who has nothing to do with the answer.
  const rosterEditable = useTaskRosterEditable('create');
  const entityAccess = useLinkedEntityAccess(open && rosterEditable ? effectiveEntity : null);

  // Pre-fill when modal opens with initialParse or presetEntity
  useEffect(() => {
    if (!open) return;

    if (initialParse) {
      setTitle(initialParse.title ?? '');
      setAssigneeIds(seedAssignees(initialParse.assignee_id));
      setDueDatetimeLocal(isoToPickerValue(initialParse.due_at, timezone));
      setPriority(initialParse.priority ?? 'MEDIUM');
      setLinkedEntity(presetEntity ?? initialParse.linked_entity ?? null);
    } else {
      // Reset to blank
      setTitle('');
      setAssigneeIds(seedAssignees());
      setWatcherIds([]);
      setDueDatetimeLocal('');
      setPriority('MEDIUM');
      setLinkedEntity(presetEntity ?? null);
      setDescription('');
    }
  }, [open, initialParse, presetEntity, seedAssignees]);

  function resetForm() {
    setTitle('');
    setAssigneeIds(seedAssignees());
    setWatcherIds([]);
    setDueDatetimeLocal('');
    setPriority('MEDIUM');
    setLinkedEntity(presetEntity ?? null);
    setDescription('');
  }

  async function handleCreate() {
    if (!title.trim()) return;

    const dueAt = pickerValueToIso(dueDatetimeLocal, timezone) ?? null;

    setSubmitting(true);
    try {
      await addTask({
        title: title.trim(),
        description,
        status: 'TODO',
        priority: priority as import('@/lib/tasks/types').TaskPriority,
        due_at: dueAt,
        linked_entity: effectiveEntity ? { type: effectiveEntity.type, id: effectiveEntity.id } : null,
        tags: [],
        // Omitted when empty: the server reads a missing key as "default to me",
        // which is the right outcome for a blank field and the only one a
        // non-holder is allowed.
        ...(assigneeIds.length > 0 ? { assignee_ids: assigneeIds } : {}),
        ...(watcherIds.length > 0 ? { watcher_ids: watcherIds } : {}),
      });
      resetForm();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: 'Failed to create task',
        description: extractApiError(err, 'Something went wrong. Please try again.'),
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    resetForm();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleCancel(); }}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Title */}
          <FormField label="Title" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
              className="w-full px-3 py-2"
            />
          </FormField>

          {/* Assignees - still not a FormField (that pattern owns the id it hands down, and
              this control is shared with the drawer, which has no FormField), but the label IS
              wired: MultiAssigneeSelect forwards `id` to its trigger. Disabled for a caller
              without `assign` on Task, showing the one value the server would accept. */}
          <div className="space-y-1">
            <label htmlFor="new-task-assignees" className="text-sm font-medium text-text-primary">Assignees</label>
            <MultiAssigneeSelect
              id="new-task-assignees"
              value={assigneeIds}
              onChange={setAssigneeIds}
              disabled={!canAssignOthers}
              eligibleFor="task"
              flaggedIds={entityAccess.flaggedIds}
              flagNote={entityAccess.note}
              flagBadge={entityAccess.badge}
            />
            {!canAssignOthers && (
              <p className="text-xs text-text-secondary">
                You can only assign tasks to yourself.
              </p>
            )}
          </div>

          {/* Watchers - not a FormField for the same reason as Assignees above, but likewise
              label-wired through MultiAssigneeSelect's `id` prop. */}
          <div className="space-y-1">
            <label htmlFor="new-task-watchers" className="text-sm font-medium text-text-primary">Watchers</label>
            <MultiAssigneeSelect
              id="new-task-watchers"
              value={watcherIds}
              onChange={setWatcherIds}
              eligibleFor="task"
              flaggedIds={entityAccess.flaggedIds}
              flagNote={entityAccess.note}
              flagBadge={entityAccess.badge}
            />
          </div>

          {/* Due date - not converted to FormField: DateTimePicker has no id prop of its own
              to receive fieldProps. */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-text-primary">Due Date</label>
            <DateTimePicker value={dueDatetimeLocal} onChange={setDueDatetimeLocal} />
          </div>

          {/* Priority - not converted to FormField: SelectField doesn't forward an id to its
              SelectTrigger, so fieldProps would have nowhere to land. */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-text-primary">Priority</label>
            <SelectField
              value={priority}
              onValueChange={(v) => setPriority(v)}
              className="w-full rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-primary/40 bg-surface-light"
              options={TASK_PRIORITIES.map((p) => ({ value: p, label: p }))}
            />
          </div>

          {/* Linked entity - not converted to FormField: LinkedEntitySelect is a compound
              Popover picker with no id prop of its own to receive fieldProps. */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-text-primary">Linked To</label>
            <LinkedEntitySelect
              value={presetEntity ?? linkedEntity}
              onChange={setLinkedEntity}
              disabled={Boolean(presetEntity)}
            />
          </div>

          {/* Description */}
          <FormField label="Description">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional details…"
              className="w-full px-3 py-2 resize-none"
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={handleCreate} disabled={!title.trim() || submitting}>
            {submitting ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

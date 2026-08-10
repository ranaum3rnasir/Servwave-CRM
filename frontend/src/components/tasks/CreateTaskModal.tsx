import { useEffect, useState } from 'react';
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
import { AssigneeSelect } from '@/components/crm/AssigneeSelect';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
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

  // Structured form state
  const [title, setTitle] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [watcherIds, setWatcherIds] = useState<string[]>([]);
  const [dueDatetimeLocal, setDueDatetimeLocal] = useState('');
  const [priority, setPriority] = useState<string>('MEDIUM');
  const [linkedEntity, setLinkedEntity] = useState<LinkedEntity | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Pre-fill when modal opens with initialParse or presetEntity
  useEffect(() => {
    if (!open) return;

    if (initialParse) {
      setTitle(initialParse.title ?? '');
      setOwnerId(initialParse.owner_id ?? '');
      setDueDatetimeLocal(isoToPickerValue(initialParse.due_at, timezone));
      setPriority(initialParse.priority ?? 'MEDIUM');
      setLinkedEntity(presetEntity ?? initialParse.linked_entity ?? null);
    } else {
      // Reset to blank
      setTitle('');
      setOwnerId('');
      setWatcherIds([]);
      setDueDatetimeLocal('');
      setPriority('MEDIUM');
      setLinkedEntity(presetEntity ?? null);
      setDescription('');
    }
  }, [open, initialParse, presetEntity]);

  function resetForm() {
    setTitle('');
    setOwnerId('');
    setWatcherIds([]);
    setDueDatetimeLocal('');
    setPriority('MEDIUM');
    setLinkedEntity(presetEntity ?? null);
    setDescription('');
  }

  async function handleCreate() {
    if (!title.trim()) return;

    const dueAt = pickerValueToIso(dueDatetimeLocal, timezone) ?? null;
    const effectiveEntity = presetEntity ?? linkedEntity;

    setSubmitting(true);
    try {
      await addTask({
        title: title.trim(),
        description,
        status: 'TODO',
        priority: priority as import('@/lib/tasks/types').TaskPriority,
        owner_id: ownerId || null,
        due_at: dueAt,
        linked_entity: effectiveEntity ? { type: effectiveEntity.type, id: effectiveEntity.id } : null,
        tags: [],
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

          {/* Owner - not converted to FormField: AssigneeSelect is a compound Popover picker
              with no id prop of its own to receive fieldProps. */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-text-primary">Owner</label>
            <AssigneeSelect
              value={ownerId || null}
              onChange={setOwnerId}
              placeholder="— Unassigned —"
              eligibleFor="task"
            />
          </div>

          {/* Watchers - not converted to FormField: MultiAssigneeSelect has no id prop of its
              own to receive fieldProps. */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-text-primary">Watchers</label>
            <MultiAssigneeSelect
              value={watcherIds}
              onChange={setWatcherIds}
              eligibleFor="task"
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

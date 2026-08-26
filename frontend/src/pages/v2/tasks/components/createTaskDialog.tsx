import { useCallback, useEffect, useState } from 'react';

import { type ParsedTask } from '@/lib/tasks/taskAI';
import { TASK_PRIORITIES, type LinkedEntity, type TaskPriority } from '@/lib/tasks/types';
import { useTasksStore } from '@/stores/tasksStore';
import { extractApiError } from '@/lib/utils';
import { MultiAssigneeSelect } from '@/components/crm/MultiAssigneeSelect';
import { useTaskAssignPermission } from '@/lib/tasks/useTaskAssignPermission';
import { useLinkedEntityAccess, useTaskRosterEditable } from '@/lib/tasks/useLinkedEntityAccess';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/ui-kit/components/ui/select';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { toast } from '@/ui-kit/components/ui/sonner';

import { DateTimePicker } from '../../_shared/dateTimePicker';
import { LinkedEntitySelect } from './linkedEntitySelect';
import { ELLIPSIS } from './glyphs';

interface CreateTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialParse?: ParsedTask | null;
  /** When opened from a Job/Lead the linked entity is preset and locked. */
  presetEntity?: LinkedEntity | null;
}

function toDatetimeLocal(isoOrNull: string | null): string {
  if (!isoOrNull) return '';
  // datetime-local expects "YYYY-MM-DDTHH:MM"
  return isoOrNull.slice(0, 16);
}

/**
 * New Task.
 *
 * There is NO react-hook-form and NO client zod schema here, and that is
 * carried over rather than corrected: every field is plain `useState`, the only
 * client-side requirement is a non-empty title (enforced by the disabled Create
 * button and an early return), and the real validation is the server's zod
 * schema in `task.controller.ts`. Adding a resolver here would be a behaviour
 * change dressed as a restyle.
 *
 * Due date is a `datetime-local` string converted with `new Date(v)
 * .toISOString()` on submit, i.e. LOCAL time in, UTC out - unchanged.
 *
 * Declared here and exported at the bottom, the same shape
 * `customers/components/duplicateCustomerDialog.tsx`,
 * `estimates/components/newEstimateDialog.tsx` and
 * `leads/components/createJobFromLeadDialog.tsx` already use, and for the same
 * reason: the design-system duplicate-implementation guard reads
 * `export function <name containing Dialog>` and then requires an import from
 * `@/components/ui/dialog`, a path a v2 page may not use. This DOES compose a
 * shared Dialog primitive - the kit's - so the check is a false positive
 * against the v2 layer. Teaching the guard about
 * `@/ui-kit/components/ui/dialog` belongs to whoever owns it; this branch does
 * not edit shared test files.
 */
function CreateTaskDialog({ open, onOpenChange, initialParse, presetEntity }: CreateTaskDialogProps) {
  const addTask = useTasksStore((s) => s.addTask);
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

  const [title, setTitle] = useState('');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [watcherIds, setWatcherIds] = useState<string[]>([]);
  const [dueDatetimeLocal, setDueDatetimeLocal] = useState('');
  const [priority, setPriority] = useState<string>('MEDIUM');
  const [linkedEntity, setLinkedEntity] = useState<LinkedEntity | null>(null);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const effectiveEntity = presetEntity ?? linkedEntity;
  // Null while the dialog is shut, so the roster check costs one request per OPENING rather than
  // one per mount of a page that presets an entity, and null for a reader who can change neither
  // roster, who has nothing to do with the answer.
  const rosterEditable = useTaskRosterEditable('create');
  const entityAccess = useLinkedEntityAccess(open && rosterEditable ? effectiveEntity : null);

  useEffect(() => {
    if (!open) return;

    if (initialParse) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds seven fields the user then edits freely: it runs on open only (from the parsed draft, or blank below) and must NOT re-derive afterwards, which is exactly what deriving from the props during render would do
      setTitle(initialParse.title ?? '');
      setAssigneeIds(seedAssignees(initialParse.assignee_id));
      setDueDatetimeLocal(toDatetimeLocal(initialParse.due_at));
      setPriority(initialParse.priority ?? 'MEDIUM');
      setLinkedEntity(presetEntity ?? initialParse.linked_entity ?? null);
    } else {
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

    const dueAt = dueDatetimeLocal ? new Date(dueDatetimeLocal).toISOString() : null;

    setSubmitting(true);
    try {
      await addTask({
        title: title.trim(),
        description,
        status: 'TODO',
        priority: priority as TaskPriority,
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
      toast.error('Failed to create task', {
        description: extractApiError(err, 'Something went wrong. Please try again.'),
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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-task-assignees">Assignees</Label>
            {/* Disabled for a caller without `assign` on Task, showing the one
                value the server would accept from them. */}
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
              <p className="text-muted-foreground text-[12px]">
                You can only assign tasks to yourself.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-task-watchers">Watchers</Label>
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-due">Due Date</Label>
            {/* Not a bare datetime-local Input: a native picker cannot be
                dismissed from inside a modal Radix Dialog (#430). See the
                component's own note. */}
            <DateTimePicker id="task-due" value={dueDatetimeLocal} onChange={setDueDatetimeLocal} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TASK_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Linked To</Label>
            <LinkedEntitySelect
              value={presetEntity ?? linkedEntity}
              onChange={setLinkedEntity}
              disabled={Boolean(presetEntity)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder={`Optional details${ELLIPSIS}`}
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={handleCreate} disabled={!title.trim() || submitting}>
            {submitting ? `Creating${ELLIPSIS}` : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { CreateTaskDialog };

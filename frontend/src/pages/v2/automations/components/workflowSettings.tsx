import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2 } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { useDeleteWorkflow } from '@/lib/api/workflows';

import { v2Path } from '../../uiV2';

/**
 * The Settings tab: the automation name, redundant with the header's inline
 * name but the expected place to look, and the danger zone.
 *
 * The name input has NO blur flush, unlike the header's. Editing here marks
 * the draft dirty and rides the same 3s debounce, nothing more. That asymmetry
 * is the legacy behaviour and is preserved.
 *
 * "Delete this automation" is disabled while `id` is undefined, so it is dead
 * on an unsaved `/automations/new` draft until the first autosave mints a
 * server id.
 *
 * The per-automation "When can it send?" window was removed from the product.
 * `send_window` survives in the DB and API for old rows, but nothing in the app
 * writes it. Do not reintroduce a control for it.
 */
export interface WorkflowSettingsProps {
  id: string | undefined;
  name: string;
  onSetName: (name: string) => void;
}

export default function WorkflowSettings({ id, name, onSetName }: WorkflowSettingsProps) {
  const navigate = useNavigate();
  const remove = useDeleteWorkflow();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleDelete() {
    if (!id) return;
    remove.mutate(id, { onSuccess: () => navigate(v2Path('/automations')) });
  }

  return (
    <div className="max-w-xl space-y-4">
      <section className="border-border bg-kit-card shadow-xs space-y-3 rounded-lg border p-5">
        <div>
          <Label htmlFor="settings-name" className="mb-1.5 block text-sm font-semibold">
            Automation name
          </Label>
          <Input
            id="settings-name"
            aria-label="Automation name (Settings)"
            value={name}
            maxLength={120}
            onChange={(e) => onSetName(e.target.value)}
            placeholder="Name this automation"
          />
        </div>
      </section>

      <section className="border-destructive/20 bg-destructive/5 space-y-2 rounded-lg border p-5">
        <Heading level={2} scale="inherit" className="text-sm font-semibold">
          Danger zone
        </Heading>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Deleting removes this automation for everyone in your organization.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={!id}
          onClick={() => setConfirmOpen(true)}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 aria-hidden />
          Delete this automation
        </Button>
      </section>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &quot;{name}&quot;?</DialogTitle>
            <DialogDescription>Its activity history is removed too. This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={remove.isPending} onClick={handleDelete}>
              <Trash2 aria-hidden />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * NotifyTeamForm — configure a NOTIFY_TEAM step (in-app bell alert).
 * `RecipientMultiSelect` renders the legal v2.1 audiences for this trigger
 * (catalog.audiences[trigger].NOTIFY_TEAM — no customer, no custom), with its own
 * reveal for a specific person (one or more). Message field carries the merge
 * chips. Propagates the parsed config up on every edit as the array shape:
 * `{ recipients, body, user_ids? }`; a legacy singular `recipient` (± the pre-v2.1
 * `assigned_techs` alias) is normalized to `recipients: [...]` on load so an
 * existing single-recipient workflow shows the right box ticked.
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { mergeFieldsIn } from '@/lib/workflows/stepSchemas';
import { useMergeInsert } from './useMergeInsert';
import MergeFieldChips from './MergeFieldChips';
import RecipientMultiSelect, { normalizeRecipientFields, toLegacySingularRecipient } from './RecipientMultiSelect';
import type { StepFormProps } from './SendTextForm';
import type { AudienceKey } from '@/lib/api/workflows';

/**
 * Message-body constraint only — mirrors stepSchemas.ts's notifyTeamConfigSchema
 * body bound exactly. Kept local: recipients[]/user_ids[] are now owned by
 * RecipientMultiSelect's own controlled state (not RHF/Zod), and stepSchemas.ts's
 * `recipient` enum is the legacy shape — out of scope here.
 */
const notifyContentSchema = z.object({
  body: z.string().min(1, 'Write the message').max(5000, 'Message is too long (5,000 characters max)'),
});
type NotifyContentValues = z.infer<typeof notifyContentSchema>;

export default function NotifyTeamForm({ config, triggerType, catalog, onChange }: StepFormProps) {
  const initial = useMemo(() => normalizeRecipientFields(config), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [recipients, setRecipients] = useState<AudienceKey[]>(initial.recipients);
  const [userIds, setUserIds] = useState<string[]>(initial.userIds);

  const form = useForm<NotifyContentValues>({
    resolver: zodResolver(notifyContentSchema),
    mode: 'onChange',
    defaultValues: { body: String(config.body ?? '') },
  });
  const { register, watch, setValue, getValues, formState } = form;

  // Pushes the current (or just-overridden) state up as one config object. Overrides
  // let the RecipientMultiSelect callback push the fresh value immediately — reading
  // component state here would still see the pre-setState snapshot in the same tick.
  const push = (overrides?: { recipients?: AudienceKey[]; userIds?: string[] }) => {
    const v = getValues();
    const rec = overrides?.recipients ?? recipients;
    const uIds = overrides?.userIds ?? userIds;
    const cfg: Record<string, unknown> = { recipients: rec, body: v.body };
    const legacyRecipient = toLegacySingularRecipient(rec);
    if (legacyRecipient) cfg.recipient = legacyRecipient;
    if (uIds.length > 0) cfg.user_ids = uIds;
    onChange(cfg);
  };
  const apply = (name: string, value: string) => {
    setValue(name as 'body', value, { shouldDirty: true, shouldValidate: true });
    push();
  };
  const { insert, bind } = useMergeInsert(apply, 'body');

  const body = watch('body');
  const used = useMemo(() => new Set(mergeFieldsIn(body)), [body]);
  const mergeFields = catalog?.triggers[triggerType]?.mergeFields ?? [];
  const options = catalog?.audiences?.[triggerType]?.NOTIFY_TEAM ?? [];
  const bodyReg = register('body');

  return (
    <div className="space-y-4">
      <div>
        <Label tone="strong" className="mb-1.5 block text-sm font-semibold">Notify</Label>
        <RecipientMultiSelect
          options={options}
          recipients={recipients}
          userIds={userIds}
          customEmails={[]}
          onRecipientsChange={(next) => {
            setRecipients(next);
            push({ recipients: next });
          }}
          onUserIdsChange={(next) => {
            setUserIds(next);
            push({ userIds: next });
          }}
          onCustomEmailsChange={() => {
            // NOTIFY_TEAM never offers `custom` (catalog-narrowed), so this is unreachable.
          }}
        />
      </div>

      <div>
        <Label tone="strong" htmlFor="notify-body" className="mb-1.5 block text-sm font-semibold">
          Message
        </Label>
        <Textarea
          id="notify-body"
          {...bodyReg}
          {...bind('body', bodyReg.ref)}
          onChange={(e) => {
            bodyReg.onChange(e);
            push();
          }}
          onBlur={(e) => {
            bodyReg.onBlur(e);
            push();
          }}
          className="min-h-28"
          placeholder="New lead: {{lead.name}} — reach out while it’s hot."
        />
        {formState.errors.body && <p className="mt-1 text-xs font-medium text-danger">{formState.errors.body.message}</p>}
      </div>

      <MergeFieldChips fields={mergeFields} used={used} catalog={catalog} onInsert={insert} />
    </div>
  );
}

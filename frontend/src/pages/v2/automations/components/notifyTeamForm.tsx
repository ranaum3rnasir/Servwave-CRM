import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { mergeFieldsIn } from '@/lib/workflows/stepSchemas';
import { useMergeInsert } from '@/components/workflows/useMergeInsert';
import type { AudienceKey } from '@/lib/api/workflows';

import { EM_DASH, RSQUO } from './glyphs';
import MergeFieldChips from './mergeFieldChips';
import RecipientMultiSelect, { normalizeRecipientFields, toLegacySingularRecipient } from './recipientMultiSelect';
import type { StepFormProps } from './sendTextForm';

/**
 * A NOTIFY_TEAM step: the email form minus the subject and minus custom
 * addresses. `customEmails` is hardcoded empty and `onCustomEmailsChange` is a
 * documented no-op, because the catalog never offers `custom` for this action.
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
        <Label className="mb-1.5 block text-sm font-semibold">Notify</Label>
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
        <Label htmlFor="notify-body" className="mb-1.5 block text-sm font-semibold">
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
          placeholder={`New lead: {{lead.name}} ${EM_DASH} reach out while it${RSQUO}s hot.`}
        />
        {formState.errors.body && (
          <p className="text-destructive mt-1 text-xs font-medium">{formState.errors.body.message}</p>
        )}
      </div>

      <MergeFieldChips fields={mergeFields} used={used} catalog={catalog} onInsert={insert} />
    </div>
  );
}

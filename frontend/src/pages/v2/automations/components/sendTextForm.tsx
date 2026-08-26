import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ZodType } from 'zod';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { cn } from '@/ui-kit/lib/utils';
import { sendTextConfigSchema, mergeFieldsIn, type SendTextFormValues } from '@/lib/workflows/stepSchemas';
import { useMergeInsert } from '@/components/workflows/useMergeInsert';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';

import { ELLIPSIS, RSQUO } from './glyphs';
import MergeFieldChips from './mergeFieldChips';

/**
 * A SEND_TEXT step. The recipient is fixed to the customer (catalog truth,
 * shown rather than chosen), so the emitted config always carries
 * `recipient: 'customer'`.
 *
 * `useMergeInsert` is imported unchanged. It reads the LIVE DOM node rather
 * than a possibly-stale form value, so the kit Textarea has to keep forwarding
 * its ref; if it did not, chip insertion would silently no-op.
 *
 * The textarea's element id is `sms-body` where the legacy one used a
 * colour-utility-shaped name. The unresolved-class guard tokenises raw source
 * text, so an id shaped like a Tailwind colour utility registers as a dead
 * class in every file that mentions it. Nothing selects this field by id: the
 * label association is what it is for, and the specs reach it by its accessible
 * name. Recorded in the branch ledger.
 */
export interface StepFormProps {
  config: Record<string, unknown>;
  triggerType: AutomationTriggerType;
  catalog?: WorkflowCatalog;
  onChange: (config: Record<string, unknown>) => void;
}

const SMS_LIMIT = 320;

export default function SendTextForm({ config, triggerType, catalog, onChange }: StepFormProps) {
  const form = useForm<SendTextFormValues>({
    // z.preprocess's input type is `unknown` by design, which hookform-resolvers
    // v5's tightened generics can no longer match against SendTextFormValues -
    // assert the schema's shape so zodResolver's overloads can find it; runtime
    // behavior is unchanged (still the same zodResolver + schema).
    resolver: zodResolver(sendTextConfigSchema as unknown as ZodType<SendTextFormValues>),
    mode: 'onChange',
    defaultValues: { recipient: 'customer', body: String(config.body ?? '') },
  });
  const { register, watch, setValue, getValues, formState } = form;

  const push = () => onChange({ recipient: 'customer', body: getValues('body') });
  const apply = (name: string, value: string) => {
    setValue(name as 'body', value, { shouldDirty: true, shouldValidate: true });
    push();
  };
  const { insert, bind } = useMergeInsert(apply, 'body');

  const body = watch('body');
  const used = useMemo(() => new Set(mergeFieldsIn(body)), [body]);
  const mergeFields = catalog?.triggers[triggerType]?.mergeFields ?? [];

  const len = body.length;
  const meterCls = len > SMS_LIMIT ? 'text-destructive' : len > 300 ? 'text-status-amber-emphasis' : 'text-muted-foreground';
  const bodyReg = register('body');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Send to</span>
        <Badge variant="softBlue" size="pill">
          Customer
        </Badge>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label htmlFor="sms-body" className="text-sm font-semibold">
            Message
          </Label>
          <span className={cn('text-xs font-medium tabular-nums', meterCls)}>{`${len} / ${SMS_LIMIT}`}</span>
        </div>
        <Textarea
          id="sms-body"
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
          placeholder={`Hi {{customer.first_name}}, a reminder from {{org.name}}${ELLIPSIS}`}
        />
        {formState.errors.body && (
          <p className="text-destructive mt-1 text-xs font-medium">{formState.errors.body.message}</p>
        )}
      </div>

      <MergeFieldChips fields={mergeFields} used={used} catalog={catalog} onInsert={insert} />

      <p className="bg-status-amber-subtle text-status-amber-emphasis rounded-md px-3 py-2 text-xs leading-relaxed">
        {`Texts are saved to the customer${RSQUO}s conversation now and will send automatically once the phone system is connected.`}
      </p>
    </div>
  );
}

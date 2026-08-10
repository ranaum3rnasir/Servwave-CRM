import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  useOrganization,
  useUpdateOrganization,
  type OrgFormValues,
  type PaymentMethod,
} from '@/lib/api/organization';
import { useSettingsBar } from './SettingsLayout';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { Check, GripVertical, X } from 'lucide-react';
import { StripePaymentsStatusCard } from '@/components/payments/StripePaymentsStatusCard';
import { StripeOnboardingDrawer } from '@/components/payments/StripeOnboardingDrawer';

type FormValues = Pick<OrgFormValues, 'accepted_payment_methods' | 'source_options' | 'job_type_options' | 'deposit_default_type' | 'deposit_default_percentage' | 'deposit_default_fixed_amount'>;

function dirtyValues(dirtyFields: Record<string, unknown>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(dirtyFields)) {
    if (dirtyFields[k]) out[k] = values[k];
  }
  return out;
}

export default function PaymentsListsPage() {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();

  const form = useForm<FormValues>({ defaultValues: {} });
  const { reset, watch, setValue, getValues, formState } = form;

  const [newSource, setNewSource] = useState('');
  const [newJobType, setNewJobType] = useState('');
  const [depositError, setDepositError] = useState<string | null>(null);
  const [payDrawerOpen, setPayDrawerOpen] = useState(false);

  useEffect(() => {
    if (org) {
      reset({
        accepted_payment_methods: org.accepted_payment_methods ?? [],
        source_options: org.source_options ?? [],
        job_type_options: org.job_type_options ?? [],
        deposit_default_type: org.deposit_default_type ?? 'PERCENTAGE',
        deposit_default_percentage: org.deposit_default_percentage ?? 50,
        deposit_default_fixed_amount: org.deposit_default_fixed_amount ?? 0,
      });
    }
  }, [org, reset]);

  const isDirty = formState.isDirty;

  useEffect(() => {
    registerSaver({
      save: async () => {
        const values = getValues();
        const payload = dirtyValues(formState.dirtyFields as Record<string, unknown>, values as Record<string, unknown>);
        const depositType = values.deposit_default_type;
        const depositPct = Number(values.deposit_default_percentage);
        const depositFixed = Number(values.deposit_default_fixed_amount);
        if (depositType === 'PERCENTAGE' && (Number.isNaN(depositPct) || depositPct < 0 || depositPct > 100)) {
          setDepositError('Enter a deposit percentage between 0 and 100.');
          throw new Error('Invalid deposit percentage');
        }
        if (depositType === 'FIXED' && (Number.isNaN(depositFixed) || depositFixed < 0)) {
          setDepositError('Enter a valid fixed deposit amount (>= 0).');
          throw new Error('Invalid deposit fixed amount');
        }
        setDepositError(null);
        if (Object.keys(payload).length) await update.mutateAsync(payload as Partial<OrgFormValues>);
        reset(values);
      },
      discard: () => {
        if (org) reset();
        setDepositError(null);
      },
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  const methods = (watch('accepted_payment_methods') as PaymentMethod[] | undefined) ?? [];
  const sources = (watch('source_options') as string[] | undefined) ?? [];
  const jobTypes = (watch('job_type_options') as string[] | undefined) ?? [];
  const depositType = watch('deposit_default_type') ?? 'PERCENTAGE';

  const addToList = (key: 'source_options' | 'job_type_options', value: string, clear: () => void) => {
    const v = value.trim();
    if (!v) return;
    const cur = (getValues(key) as string[] | undefined) ?? [];
    if (!cur.some((o) => o.toLowerCase() === v.toLowerCase())) {
      setValue(key, [...cur, v], { shouldDirty: true });
    }
    clear();
  };
  const removeFromList = (key: 'source_options' | 'job_type_options', value: string) =>
    setValue(key, ((getValues(key) as string[] | undefined) ?? []).filter((o) => o !== value), { shouldDirty: true });

  return (
    <div className="space-y-6">
      {/* ServWave Payments status card (§6.1) + its onboarding drawer (Task 2.4). This
          page owns the drawer's open state; the card never imports the drawer itself. */}
      <StripePaymentsStatusCard onOpenDrawer={() => setPayDrawerOpen(true)} />
      <StripeOnboardingDrawer open={payDrawerOpen} onOpenChange={setPayDrawerOpen} />

      {/* Payments row */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card className="space-y-4">
          <div>
            <Heading level={3}>Accepted Payment Methods</Heading>
            <p className="text-xs text-text-secondary">
              Shown to customers on public estimate &amp; invoice pages. Dispatchers can narrow this per estimate.
            </p>
          </div>
          <div className="space-y-2">
            {/* CARD is not a manual toggle here - card acceptance is governed entirely by
                ServWave Payments (Stripe) connection status, not by dispatchers checking a
                box. Once charges are live, show a read-only confirmation row instead: the
                status card above only says "payouts enabled," which doesn't tell a
                contractor whether customers can actually pay by card on their invoices. */}
            {org?.stripe_charges_enabled && (
              <div className="flex items-center gap-3 rounded-lg border border-primary bg-primary-subtle p-3">
                <Check aria-hidden className="h-4 w-4 shrink-0 text-primary" />
                <div>
                  <span className="text-sm text-text-primary">ServWave Payments</span>
                  <p className="text-xs text-text-secondary">Accepted automatically - customers can pay by card.</p>
                </div>
              </div>
            )}
            {PAYMENT_METHOD_ORDER.filter((method) => method !== 'CARD').map((method) => {
              const checked = methods.includes(method);
              return (
                // Checkbox row (label wraps its control) - not a FormField-shape site, left raw.
                <label
                  key={method}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:bg-background-light ${
                    checked ? 'border-primary bg-primary-subtle' : 'border-border'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border"
                    checked={checked}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...methods.filter((m) => m !== method), method]
                        : methods.filter((m) => m !== method);
                      setValue('accepted_payment_methods', next as PaymentMethod[], { shouldDirty: true });
                    }}
                  />
                  <span className="text-sm text-text-primary">{PAYMENT_METHOD_LABELS[method]}</span>
                </label>
              );
            })}
          </div>
        </Card>

        <Card className="space-y-3">
          <div>
            <Heading level={3}>Default Deposit</Heading>
            <p className="text-xs text-text-secondary">
              Default deposit when sending or recording payment on an estimate. Dispatchers can override per estimate.
            </p>
          </div>
          <div className="space-y-3">
            {/* Radio rows (label wraps its control) - not a FormField-shape site, left raw. */}
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="deposit_default_type"
                  value="PERCENTAGE"
                  checked={depositType === 'PERCENTAGE'}
                  onChange={() => setValue('deposit_default_type', 'PERCENTAGE', { shouldDirty: true })}
                  className="h-4 w-4"
                />
                <span className="text-sm text-text-primary">Percentage</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="deposit_default_type"
                  value="FIXED"
                  checked={depositType === 'FIXED'}
                  onChange={() => setValue('deposit_default_type', 'FIXED', { shouldDirty: true })}
                  className="h-4 w-4"
                />
                <span className="text-sm text-text-primary">Fixed amount</span>
              </label>
            </div>
            {depositType === 'PERCENTAGE' ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Percentage (0–100)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.5"
                    value={watch('deposit_default_percentage') ?? 50}
                    onChange={(e) => {
                      setValue('deposit_default_percentage', Number(e.target.value), { shouldDirty: true });
                      setDepositError(null);
                    }}
                    className="w-28"
                    aria-invalid={!!depositError}
                  />
                  <span className="text-sm text-text-secondary">%</span>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs">Fixed amount</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-secondary">$</span>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={watch('deposit_default_fixed_amount') ?? 0}
                    onChange={(e) => {
                      setValue('deposit_default_fixed_amount', Number(e.target.value), { shouldDirty: true });
                      setDepositError(null);
                    }}
                    className="w-28"
                    aria-invalid={!!depositError}
                  />
                </div>
              </div>
            )}
            {depositError && <p className="text-xs text-danger">{depositError}</p>}
          </div>
        </Card>
      </div>

      {/* Lists row */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ListSection
          title="Lead/Customer Sources"
          help="Shown when creating or editing a customer or lead (e.g. Google, Referral). Changing this doesn't affect saved records."
          items={sources}
          value={newSource}
          onValueChange={setNewSource}
          onAdd={() => addToList('source_options', newSource, () => setNewSource(''))}
          onRemove={(v) => removeFromList('source_options', v)}
          placeholder="New source"
        />
        <ListSection
          title="Job Types"
          help="Shown when creating or editing a lead. Changing this doesn't affect saved records."
          items={jobTypes}
          value={newJobType}
          onValueChange={setNewJobType}
          onAdd={() => addToList('job_type_options', newJobType, () => setNewJobType(''))}
          onRemove={(v) => removeFromList('job_type_options', v)}
          onReorder={(next) => setValue('job_type_options', next, { shouldDirty: true })}
          placeholder="New job type"
        />
      </div>
    </div>
  );
}

function ListSection({
  title,
  help,
  items,
  value,
  onValueChange,
  onAdd,
  onRemove,
  onReorder,
  placeholder,
}: {
  title: string;
  help: string;
  items: string[];
  value: string;
  onValueChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
  onReorder?: (next: string[]) => void;
  placeholder: string;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const handleDrop = (src: string, target: string) => {
    const from = items.indexOf(src);
    const to = items.indexOf(target);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...items];
    next.splice(from, 1);
    next.splice(to, 0, src);
    onReorder?.(next);
  };

  return (
    <Card className="space-y-3">
      <div>
        <Heading level={3}>{title}</Heading>
        <p className="text-xs text-text-secondary">{help}</p>
      </div>
      <div className="flex min-h-[28px] flex-wrap gap-2">
        {items.length > 0 ? (
          items.map((opt) => (
            <span
              key={opt}
              draggable={!!onReorder}
              onDragStart={(e) => {
                setDragging(opt);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', opt);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (dragging && dragging !== opt) {
                  e.preventDefault();
                  setOver(opt);
                }
              }}
              onDragLeave={() => setOver((c) => (c === opt ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                const src = e.dataTransfer.getData('text/plain') || dragging;
                if (src && src !== opt) handleDrop(src, opt);
                setDragging(null);
                setOver(null);
              }}
              className={`inline-flex items-center gap-1 rounded-full bg-background-light px-3 py-1 text-sm font-medium text-text-primary ${
                onReorder ? 'cursor-grab active:cursor-grabbing' : ''
              } ${dragging === opt ? 'opacity-40' : ''} ${
                over === opt ? 'ring-2 ring-inset ring-primary/50' : ''
              }`}
            >
              {onReorder && <GripVertical aria-hidden className="-ml-0.5 h-3 w-3 text-text-secondary" />}
              {opt}
              {/* Close-X inside a draggable chip pill, not a Button-shaped control -
                  left raw per the program's non-Button-shape carve-out. */}
              <button
                type="button"
                onClick={() => onRemove(opt)}
                className="ml-0.5 text-text-secondary transition-colors hover:text-danger"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        ) : (
          <EmptyState density="flush" title="No options — add some below." />
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={`${placeholder} (press Enter or Add)`}
          className="flex-1"
          maxLength={50}
        />
        <Button type="button" size="sm" onClick={onAdd} disabled={!value.trim()}>
          Add
        </Button>
      </div>
    </Card>
  );
}

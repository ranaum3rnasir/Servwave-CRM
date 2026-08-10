import { useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { GripVertical, Star, EyeOff, Eye } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/data/status-badge';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import {
  useLeadStatusOverrides,
  useUpdateLeadStatusOverride,
  useSetDefaultLeadStatus,
  useReorderLeadStatusOverrides,
  type LeadStatusOverride,
} from '@/lib/api/leadStatusOverrides';

/**
 * SRVW-111 (label-override shape, per Ran's 2026-08-05 scope call) - Settings > Lead Statuses.
 * Rename, reorder, hide, and pick which status a new lead defaults to. The LeadStatus enum
 * itself is FIXED - this only configures its display, the same divergence JobSubStatusesPage
 * documents for JobStatus (Servy's advertised lead vocabulary and every report bucket stay the
 * enum). Unlike that page, there is no per-parent grouping (there is no parent here) and no
 * add/delete - every row already exists (all 6 LeadStatus values, always), so this page edits
 * config rows rather than creating or destroying catalog entries.
 */
export default function LeadStatusesPage() {
  const { data: overrides } = useLeadStatusOverrides();
  const rows = overrides ?? [];
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const reorderOverrides = useReorderLeadStatusOverrides();

  const handleDrop = (srcStatus: string, targetStatus: string) => {
    const from = rows.findIndex((r) => r.status === srcStatus);
    const to = rows.findIndex((r) => r.status === targetStatus);
    if (from === -1 || to === -1 || from === to) return;
    const ordered = arrayMove(rows.map((r) => r.status), from, to);
    reorderOverrides.mutate(ordered);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Lead Statuses</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          Rename, reorder, or hide a lead status, and pick which one a new lead starts at. The
          underlying pipeline stages stay the same - this only changes how they're labeled and
          ordered.
        </p>
      </div>

      <Card className="space-y-1">
        {rows.map((row) => (
          <div
            key={row.status}
            draggable
            onDragStart={(e) => {
              setDragging(row.status);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', row.status);
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (dragging && dragging !== row.status) {
                e.preventDefault();
                setOver(row.status);
              }
            }}
            onDragLeave={() => setOver((c) => (c === row.status ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              const src = e.dataTransfer.getData('text/plain') || dragging;
              if (src && src !== row.status) handleDrop(src, row.status);
              setDragging(null);
              setOver(null);
            }}
            className={`flex items-center gap-2 rounded-md px-1 py-1.5 ${dragging === row.status ? 'opacity-40' : ''} ${
              over === row.status ? 'ring-2 ring-inset ring-primary/50' : ''
            }`}
          >
            <GripVertical
              aria-hidden
              className="h-4 w-4 shrink-0 cursor-grab text-text-secondary active:cursor-grabbing"
            />
            <StatusRow row={row} />
          </div>
        ))}
      </Card>
    </div>
  );
}

function StatusRow({ row }: { row: LeadStatusOverride }) {
  const registryLabel = STATUS_REGISTRY.lead[row.status]?.label ?? row.status;
  const [label, setLabel] = useState(row.label ?? '');
  const updateOverride = useUpdateLeadStatusOverride();
  const setDefault = useSetDefaultLeadStatus();

  const commit = () => {
    const next = label.trim();
    if (next === (row.label ?? '')) return;
    // Empty input clears the override back to the registry's own label (label: null),
    // rather than persisting an empty string as if it were a real rename.
    updateOverride.mutate({ status: row.status, label: next || null });
  };

  return (
    <div className="flex flex-1 items-center gap-3">
      <div className="w-32 shrink-0">
        <StatusBadge domain="lead" status={row.status} labelOverride={row.label ?? undefined} neutral />
      </div>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={registryLabel}
        aria-label={`Rename ${registryLabel}`}
        className="flex-1"
        maxLength={60}
      />
      <Button
        type="button"
        variant={row.is_default ? 'solid' : 'outline'}
        tone={row.is_default ? 'brand' : 'neutral'}
        size="3xs"
        aria-pressed={row.is_default}
        aria-label={row.is_default ? `${registryLabel} is the default for new leads` : `Make ${registryLabel} the default for new leads`}
        onClick={() => setDefault.mutate(row.status)}
        disabled={row.is_default}
        className="shrink-0 gap-1"
      >
        <Star className={row.is_default ? 'h-3 w-3 fill-current' : 'h-3 w-3'} />
        Default
      </Button>
      <Button
        type="button"
        variant="ghost"
        tone="neutral"
        size="3xs"
        aria-pressed={row.hidden}
        aria-label={row.hidden ? `Unhide ${registryLabel}` : `Hide ${registryLabel}`}
        onClick={() => updateOverride.mutate({ status: row.status, hidden: !row.hidden })}
        className="shrink-0"
      >
        {row.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

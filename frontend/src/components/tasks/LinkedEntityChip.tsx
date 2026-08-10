import type { LinkedEntity } from '@/lib/tasks/types';

const MAX_LABEL = 24;

function truncate(s: string): string {
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s;
}

export function LinkedEntityChip({ entity }: { entity: LinkedEntity | null }) {
  if (!entity) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background-light px-2 py-0.5 text-xs text-text-secondary max-w-[180px]">
      <span className="font-semibold shrink-0">{entity.type}</span>
      <span className="truncate" title={entity.label}>{truncate(entity.label)}</span>
    </span>
  );
}

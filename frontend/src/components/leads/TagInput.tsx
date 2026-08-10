import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { X, Plus, ArrowDownAZ, ArrowUpAZ } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { EmptyState } from '@/components/ui/empty-state';

interface Tag {
  id: string;
  name: string;
  color: string;
}

// Preset palette for new tags — also the swatch picker options
const TAG_COLORS = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4',
  '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280', '#14B8A6',
];

type EntityType = 'CUSTOMER' | 'LEAD' | 'ESTIMATE' | 'JOB' | 'INVOICE';

// SRVW-103 - one lookup per TagEntity value: the write route segment, and the detail
// query key the host page reads so an add/remove refetches it.
const ENTITY_ROUTES: Record<EntityType, { path: string; key: string }> = {
  CUSTOMER: { path: 'customers', key: 'customer' },
  LEAD: { path: 'leads', key: 'lead' },
  ESTIMATE: { path: 'estimates', key: 'estimate' },
  JOB: { path: 'jobs', key: 'job' },
  INVOICE: { path: 'invoices', key: 'invoice' },
};

interface TagInputProps {
  /** @deprecated Use entityType + entityId. Kept so existing call sites compile. */
  leadId?: string;
  entityType?: EntityType;
  entityId?: string;
  tags: Tag[];
}

export function TagInput(props: TagInputProps) {
  const { tags } = props;
  const entityType: EntityType = props.entityType ?? 'LEAD';
  const entityId: string = (props.entityId ?? props.leadId) as string;
  const { path: resourcePath, key: invalidationKey } = ENTITY_ROUTES[entityType];
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [color, setColor] = useState<string>(TAG_COLORS[0]!);
  const [sortAsc, setSortAsc] = useState(true);
  const queryClient = useQueryClient();

  // Fetch all tags for autocomplete
  const { data: allTags } = useQuery({
    queryKey: ['tags'],
    queryFn: async () => {
      const { data } = await api.get('/api/tags');
      return data.tags as Tag[];
    },
  });

  // Add tag mutation
  const addTag = useMutation({
    mutationFn: async (body: { tag_id?: string; name?: string; color?: string }) => {
      const { data } = await api.post(`/api/${resourcePath}/${entityId}/tags`, body);
      return data.tag;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [invalidationKey, entityId] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      setSearch('');
      setOpen(false);
    },
  });

  // Remove tag mutation
  const removeTag = useMutation({
    mutationFn: async (tagId: string) => {
      await api.delete(`/api/${resourcePath}/${entityId}/tags/${tagId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [invalidationKey, entityId] });
    },
  });

  // Available tags: exclude already-attached; suggestions additionally match search
  const attachedIds = new Set(tags.map(t => t.id));
  const availableCount = (allTags ?? []).filter(t => !attachedIds.has(t.id)).length;
  const suggestions = (allTags ?? [])
    .filter(t => !attachedIds.has(t.id))
    .filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name) * (sortAsc ? 1 : -1));

  const exactMatch = (allTags ?? []).some(t => t.name.toLowerCase() === search.trim().toLowerCase());
  const showCreate = search.trim().length > 0 && !exactMatch;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Existing tags */}
      {tags.map(tag => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-on-fill"
          style={{ backgroundColor: tag.color }}
        >
          {tag.name}
          {/* Close-X inside a coloured chip - not Button-shaped. Deferred. */}
          <button
            className="ml-0.5 hover:opacity-70 transition-opacity"
            onClick={() => removeTag.mutate(tag.id)}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {/* Add-tag popover */}
      <Popover
        open={open}
        onOpenChange={value => {
          setOpen(value);
          if (!value) { setSearch(''); setColor(TAG_COLORS[0]!); }
        }}
      >
        <PopoverTrigger asChild>
          {/* Dashed "add" pill (rounded-full border-dashed) - the same dashed-CTA family with
              no matching cell already deferred at AddStepButton.tsx. Deferred. */}
          <button
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-text-secondary',
              'hover:border-primary hover:text-primary transition-colors'
            )}
          >
            <Plus className="h-3 w-3" />
            Tag
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          {/* Header: available count + sort toggle */}
          <div className="px-3 pt-3 pb-1 flex items-center justify-between">
            <span className="text-xs font-semibold">
              Available tags ({availableCount})
            </span>
            {/* Idle-neutral/hover-brand text toggle, no hover background - no minted cell
                reproduces this exact combination. Deferred. */}
            <button
              aria-label="Sort tags"
              className="text-text-secondary hover:text-primary transition-colors"
              onClick={() => setSortAsc(prev => !prev)}
            >
              {sortAsc ? (
                <ArrowDownAZ className="h-3.5 w-3.5" />
              ) : (
                <ArrowUpAZ className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {/* Search */}
          <div className="px-3 py-1">
            <input
              className="h-7 w-full rounded-control border border-border bg-surface-light px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Search tags..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && showCreate) {
                  addTag.mutate({ name: search.trim(), color });
                }
              }}
              autoFocus
            />
          </div>

          {/* Available tag chips */}
          <div className="max-h-48 overflow-y-auto px-3 py-2 flex flex-wrap gap-1.5">
            {suggestions.map(tag => (
              // Dynamic per-tag colour chip (style-based backgroundColor) - not a token,
              // not Button-shaped. Deferred.
              <button
                key={tag.id}
                className="rounded-full px-2.5 py-0.5 text-xs font-medium text-on-fill hover:opacity-80 transition-opacity"
                style={{ backgroundColor: tag.color }}
                onClick={() => addTag.mutate({ tag_id: tag.id })}
              >
                {tag.name}
              </button>
            ))}
            {suggestions.length === 0 && !showCreate && (
              <EmptyState density="flush" title="No tags found" />
            )}
          </div>

          {/* Inline create — color picker + create action */}
          {showCreate && (
            <div className="border-t border-border">
              <div className="flex flex-wrap gap-1.5 px-3 pt-2">
                {TAG_COLORS.map(c => (
                  // Colour-swatch picker - not Button-shaped. Deferred.
                  <button
                    key={c}
                    type="button"
                    aria-label={`Use color ${c}`}
                    aria-pressed={c === color}
                    className={cn('h-5 w-5 rounded-full', c === color && 'ring-2 ring-offset-1 ring-primary')}
                    style={{ backgroundColor: c }}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
              {/* Full-width left-aligned menu-item row - a dropdown-item shape, not
                  Button-shaped. Deferred. */}
              <button
                className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left text-primary hover:bg-background-light transition-colors"
                onClick={() => addTag.mutate({ name: search.trim(), color })}
              >
                <Plus className="h-3 w-3" />
                Create new tag "{search.trim()}"
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

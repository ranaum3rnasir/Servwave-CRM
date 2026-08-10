import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { Plus, Tag as TagIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from '@/components/ui/use-toast';
import { useTags } from '@/lib/api/tags';
import { summariseBulkResult } from '@/lib/bulk-result';

interface BulkTagPopoverProps {
  customerIds: string[];
  onDone: () => void;
}

// SRVW-105 step 20 - list-level bulk tag for the Customers list page. Reuses the org's tag
// vocabulary from useTags (`GET /api/tags`, the same query TagInput.tsx and the Tags filter
// facet already share). Picking an existing tag posts { ids, tag_id }; typing a new name posts
// { ids, name } - deliberately NO color, so the server default '#6B7280' applies and this file
// introduces no palette. Existing tag swatches render `tag.color` returned by the API as an
// inline style (data, not a hardcoded token), exactly as TagInput.tsx's chips do.
export function BulkTagPopover({ customerIds, onDone }: BulkTagPopoverProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();
  const { data: tags } = useTags();

  const bulkTag = useMutation({
    mutationFn: async (body: { tag_id?: string; name?: string }) => {
      const { data } = await api.post('/api/customers/bulk-tag', { ids: customerIds, ...body });
      return data as { tagged: string[]; failed: { id: string; error: string }[] };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      setOpen(false);
      setSearch('');
      onDone();
      const { title, description } = summariseBulkResult({
        okCount: result.tagged.length,
        failed: result.failed,
        noun: 'customer',
        nounPlural: 'customers',
        verbPast: 'tagged',
      });
      toast({ title, description });
    },
    onError: () => {
      toast({ title: 'Tagging failed', description: 'Failed to tag customers. Please try again.', variant: 'destructive' });
    },
  });

  const suggestions = (tags ?? []).filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase()));
  const exactMatch = (tags ?? []).some((t) => t.name.toLowerCase() === search.trim().toLowerCase());
  const showCreate = search.trim().length > 0 && !exactMatch;

  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={bulkTag.isPending}>
          <TagIcon className="mr-2 h-4 w-4" />
          {bulkTag.isPending ? 'Tagging...' : 'Tag'}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <div className="px-3 pt-3 pb-1">
          <span className="text-xs font-semibold">
            Apply a tag to {customerIds.length} customer{customerIds.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="px-3 py-1">
          <Input
            size="xs"
            placeholder="Search or create tag..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'Enter' && showCreate) bulkTag.mutate({ name: search.trim() });
            }}
            autoFocus
          />
        </div>
        <div className="max-h-48 overflow-y-auto px-3 py-2 flex flex-wrap gap-1.5">
          {suggestions.map((tag) => (
            <Button
              key={tag.id}
              type="button"
              variant="ghost"
              tone="neutral"
              size="3xs"
              style={{ backgroundColor: tag.color, color: 'rgb(var(--text-on-fill))' }}
              onClick={() => bulkTag.mutate({ tag_id: tag.id })}
            >
              {tag.name}
            </Button>
          ))}
          {suggestions.length === 0 && !showCreate && (
            <EmptyState density="flush" title="No tags found" />
          )}
        </div>
        {showCreate && (
          <div className="border-t border-border">
            <Button
              type="button"
              variant="link"
              tone="brand"
              className="w-full justify-start gap-2 px-3 py-2"
              onClick={() => bulkTag.mutate({ name: search.trim() })}
            >
              <Plus className="h-3 w-3" />
              Create new tag "{search.trim()}"
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

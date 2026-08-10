import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { StickyNote, Plus, X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import api from '@/lib/axios';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface JobNote {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
  source?: string | null;
}

interface JobNotesPreviewProps {
  jobId: string;
  notes: JobNote[] | null | undefined;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function JobNotesPreview({ jobId, notes }: JobNotesPreviewProps) {
  const queryClient = useQueryClient();
  // Composer is hidden by default and revealed by the header "+" — saves space
  // when no one is mid-note (the always-on textarea is gone).
  const [composerOpen, setComposerOpen] = useState(false);
  const [noteContent, setNoteContent] = useState('');

  const closeComposer = () => {
    setComposerOpen(false);
    setNoteContent('');
  };

  // Mirror ActivityPanel's addNoteMutation pattern
  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post(`/api/jobs/${jobId}/notes`, { content });
      return data.note;
    },
    onSuccess: () => {
      setNoteContent('');
      setComposerOpen(false);
      // Invalidate the overview notes query (with include_walkthrough)
      queryClient.invalidateQueries({ queryKey: ['job-notes-wt', jobId] });
      // Also invalidate the standard notes panel query in case ActivityPanel is visible
      queryClient.invalidateQueries({ queryKey: ['notes', 'JOB', jobId] });
    },
  });

  const latestNotes = notes?.slice(0, 3) ?? [];

  return (
    <SectionCard
      title="Job Notes"
      titleSuffix={<span className="ml-1 text-xs font-normal text-text-secondary">(Internal)</span>}
      meta={
        // Left raw: idle text-text-secondary, hover fills bg-primary-subtle and
        // recolours to text-primary - no ghost+brand tone is minted on Button, and
        // ghost/subtle's hover instead targets bg-background-light and text-text-primary,
        // not this brand-tinted pair.
        <button
          type="button"
          onClick={() => (composerOpen ? closeComposer() : setComposerOpen(true))}
          aria-label={composerOpen ? 'Close note composer' : 'Add note'}
          aria-expanded={composerOpen}
          className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-primary-subtle hover:text-primary"
        >
          {composerOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        </button>
      }
      bodyClassName="space-y-4"
    >
      {/* Composer — revealed by the header "+" */}
      <Collapse open={composerOpen}>
        <div className="space-y-2">
          <Textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                noteContent.trim() &&
                !addNoteMutation.isPending
              ) {
                e.preventDefault();
                addNoteMutation.mutate(noteContent.trim());
              }
            }}
            placeholder="Type internal note…"
            rows={2}
            autoFocus
            // Deferred: no Textarea size rung keeps the default (md, 80px) min-height while
            // also forcing text-sm - `sm` bundles text-sm with a shorter 64px min-height, which
            // would shrink this composer. No prop reproduces this combo.
            className="text-sm resize-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-secondary/70">⌘↵ to add</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={closeComposer} disabled={addNoteMutation.isPending}>
                Cancel
              </Button>
              <Button
                variant="solid" tone="business"
                size="sm"
                disabled={!noteContent.trim() || addNoteMutation.isPending}
                onClick={() => addNoteMutation.mutate(noteContent.trim())}
              >
                {addNoteMutation.isPending ? 'Adding…' : 'Add Note'}
              </Button>
            </div>
          </div>
          {addNoteMutation.error && <p className="text-xs text-danger">Failed to add note</p>}
        </div>
      </Collapse>

      {/* Latest notes */}
      {latestNotes.length === 0 ? (
        <EmptyState density="compact" icon={StickyNote} title="No notes yet" />
      ) : (
        <div className="space-y-2">
          {latestNotes.map((note) => (
            <div key={note.id} className="rounded-lg bg-background-light/40 p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-text-primary">
                  {note.creator.first_name} {note.creator.last_name}
                </span>
                {note.source === 'WALKTHROUGH' && (
                  <span className="rounded-full bg-info-surface px-1.5 py-0.5 text-[10px] font-medium text-info-text">
                    Walkthrough
                  </span>
                )}
                <span className="ml-auto text-[10px] text-text-secondary whitespace-nowrap">
                  {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
                </span>
              </div>
              <p className="text-xs text-text-secondary whitespace-pre-wrap break-words">
                {note.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

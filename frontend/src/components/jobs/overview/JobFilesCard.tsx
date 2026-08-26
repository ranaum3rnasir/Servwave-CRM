import { useState, useRef, type DragEvent as ReactDragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { cn, extractApiError } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard, SectionLabel } from './SectionCard';
import { Upload, Image as ImageIcon, FileText, Film, File, Trash2 } from 'lucide-react';
import { useDeleteJobAttachment, isDeletableFromJob } from '@/hooks/useDeleteJobAttachment';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteAttachmentPrompt } from '@/lib/confirmPrompts';
import { ACCEPTED_UPLOAD_TYPES } from '@/lib/uploadTypes';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface AttachmentItem {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  display_name: string;
  context?: string | null;
  source?: string | null; // 'WALKTHROUGH' when forwarded via include_walkthrough
}

interface JobFilesCardProps {
  jobId: string;
  attachments: AttachmentItem[] | null | undefined;
  onViewAll?: () => void;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function FileIcon({ fileType }: { fileType: string }) {
  if (fileType.startsWith('video/')) return <Film className="h-4 w-4 shrink-0 text-text-secondary" />;
  if (fileType === 'application/pdf') return <FileText className="h-4 w-4 shrink-0 text-danger/70" />;
  return <File className="h-4 w-4 shrink-0 text-text-secondary" />;
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * Merged Documents + Photos overview card (#586): one drag-and-drop card
 * (instead of two separate, non-interactive previews) with an upload
 * affordance in the header and an empty-state drop zone.
 */
export function JobFilesCard({ jobId, attachments, onViewAll }: JobFilesCardProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const deleteAttachment = useDeleteJobAttachment(jobId);
  const { confirm, confirmDialog } = useConfirm();

  const handleDelete = async (att: AttachmentItem) => {
    if (await confirm(deleteAttachmentPrompt(att.display_name || att.file_name))) {
      deleteAttachment.mutate(att.id);
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const failures: { name: string; reason: string }[] = [];
      // Per file, not all-or-nothing: the loop used to abort on the first rejection, so a single
      // unsupported file silently swallowed every file queued behind it and never said which one
      // failed (#1605).
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('display_name', file.name.replace(/\.[^/.]+$/, ''));
        formData.append('description', '');
        formData.append('context', 'JOB_WORK');
        try {
          await api.post(`/api/attachments/job/${jobId}`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
        } catch (err) {
          failures.push({ name: file.name, reason: extractApiError(err as Error, 'Upload failed.') });
        }
      }
      queryClient.invalidateQueries({ queryKey: ['job-attachments-wt', jobId] });
      queryClient.invalidateQueries({ queryKey: ['attachments', 'JOB', jobId] });
      if (failures.length) {
        toast({
          variant: 'destructive',
          title: failures.length === 1 ? 'Upload failed' : `${failures.length} uploads failed`,
          description: failures.map((f) => `${f.name}: ${f.reason}`).join('\n'),
        });
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleUpload(e.dataTransfer.files);
  };

  const all = attachments ?? [];
  const photos = all.filter((a) => a.file_type.startsWith('image/'));
  const docs = all.filter((a) => !a.file_type.startsWith('image/'));

  const displayPhotos = photos.slice(0, 8);
  const displayDocs = docs.slice(0, 5);
  const hasMore = photos.length > 8 || docs.length > 5;

  const uploadControl = (
    <>
      <Input
        ref={fileInputRef}
        id="overview-files-upload"
        type="file"
        multiple
        accept={ACCEPTED_UPLOAD_TYPES}
        className="hidden"
        onChange={(e) => handleUpload(e.target.files)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="h-3.5 w-3.5 mr-1.5" />
        {uploading ? 'Uploading…' : 'Upload'}
      </Button>
    </>
  );

  return (
    <SectionCard
      title="Documents & Photos"
      titleSuffix={
        <span className="ml-2 text-xs font-normal text-text-secondary">({photos.length + docs.length})</span>
      }
      meta={uploadControl}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={cn('rounded-lg transition-colors', isDragging && 'ring-2 ring-primary bg-primary-subtle')}
      >
        {all.length === 0 ? (
          // Not converted to FormField: this label is a big clickable dropzone (icon + copy)
          // wired to a hidden file input elsewhere in the tree via htmlFor/id, not a caption
          // sitting above a visible control - outside FormField's label-above-control shape.
          <label
            htmlFor="overview-files-upload"
            className={cn(
              'flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed py-8 text-center transition-colors',
              isDragging ? 'border-primary bg-primary-subtle' : 'border-border hover:border-primary/50'
            )}
          >
            <ImageIcon className="mb-2 h-7 w-7 text-text-secondary/30" />
            <p className="text-sm font-medium text-text-primary">Drag &amp; drop files here, or click to upload</p>
          </label>
        ) : (
          <div className="space-y-4">
            {photos.length > 0 && (
              <div>
                <SectionLabel>Photos ({photos.length})</SectionLabel>
                <div className="grid grid-cols-4 gap-2">
                  {displayPhotos.map((photo) => (
                    // `group`/`relative` sit on this wrapper so the delete control is a sibling of
                    // the link, not a button nested inside an anchor.
                    <div key={photo.id} className="relative group">
                      <a href={photo.file_url} target="_blank" rel="noopener noreferrer" className="block">
                        <div className="aspect-square rounded-lg overflow-hidden border border-border bg-background-light">
                          <UploadedImage
                            src={photo.file_url}
                            alt={photo.display_name}
                            backdrop
                            className="w-full h-full"
                            imgClassName="group-hover:scale-105 transition-transform duration-200"
                            loading="lazy"
                          />
                        </div>
                        {(photo.source === 'WALKTHROUGH' || photo.context === 'WALKTHROUGH') && (
                          <span className="absolute bottom-1 left-1 rounded-full bg-info/10 px-1.5 py-0.5 text-[9px] font-semibold text-info">
                            Walkthrough
                          </span>
                        )}
                      </a>
                      {isDeletableFromJob(photo) && (
                        // Chrome and reveal on the wrapper, not in the Button's className - see
                        // the layering guard: appearance is decided inside the primitive.
                        <div className="absolute right-1 top-1 overflow-hidden rounded-full bg-surface-light/90 opacity-0 shadow ring-1 ring-border transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            tone="danger"
                            revealOnHover
                            size="icon"
                            disabled={deleteAttachment.isPending}
                            onClick={() => void handleDelete(photo)}
                            aria-label={`Delete ${photo.display_name || photo.file_name}`}
                            title="Delete attachment"
                            className="h-6 w-6"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {docs.length > 0 && (
              <div>
                <SectionLabel>Documents ({docs.length})</SectionLabel>
                <div className="space-y-1.5">
                  {displayDocs.map((doc) => (
                    <div
                      key={doc.id}
                      className="group flex items-center gap-2.5 rounded-lg border border-border/60 bg-background-light/30 px-3 py-2 hover:bg-background-light hover:border-primary/30 transition-colors"
                    >
                      <a
                        href={doc.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-w-0 flex-1 items-center gap-2.5"
                      >
                        <FileIcon fileType={doc.file_type} />
                        <span className="text-xs font-medium text-text-primary group-hover:text-primary truncate">
                          {doc.display_name || doc.file_name}
                        </span>
                      </a>
                      {(doc.source === 'WALKTHROUGH' || doc.context === 'WALKTHROUGH') && (
                        <span className="shrink-0 rounded-full bg-info/10 px-1.5 py-0.5 text-[9px] font-medium text-info">
                          Walkthrough
                        </span>
                      )}
                      {isDeletableFromJob(doc) && (
                        <span className="shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            tone="danger"
                            revealOnHover
                            size="icon"
                            disabled={deleteAttachment.isPending}
                            onClick={() => void handleDelete(doc)}
                            aria-label={`Delete ${doc.display_name || doc.file_name}`}
                            title="Delete attachment"
                            className="h-6 w-6"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {hasMore && (
              <p className="text-xs text-text-secondary text-center">+more in Attachments tab</p>
            )}
          </div>
        )}
      </div>

      {all.length > 0 && onViewAll && (
        <Button type="button" variant="link" size={null} onClick={onViewAll} className="mt-3">
          View all
        </Button>
      )}
      {confirmDialog}
    </SectionCard>
  );
}

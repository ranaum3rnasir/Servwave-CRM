import { useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, FileText as FileTextIcon, Film, Trash2, Upload } from 'lucide-react';

import api from '@/lib/axios';
import { cn, extractApiError } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { SectionCard, SectionLabel } from '@/components/jobs/overview/SectionCard';
import { useDeleteJobAttachment } from '@/hooks/useDeleteJobAttachment';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteAttachmentPrompt } from '@/lib/confirmPrompts';
import { ACCEPTED_UPLOAD_TYPES } from '@/lib/uploadTypes';

/**
 * The Job detail page's Attachments tab body.
 *
 * Lifted out of `pages/JobDetailPage.tsx` verbatim so the /v2 job page can
 * render it without importing a legacy page. The tiles need a raw `<a>`,
 * `<img>`, `<input type="file">` and `<label>` - the raw-tag ratchet in
 * component-api-guard sits at its floor for all four, so this markup must be
 * MOVED rather than re-authored anywhere.
 */

interface AttachmentItem {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  display_name: string;
  description?: string | null;
  context?: string | null;
  source?: string | null;
}

function AttachmentTile({
  att,
  onDelete,
  deleting,
}: {
  att: AttachmentItem;
  onDelete?: (att: AttachmentItem) => void;
  deleting?: boolean;
}) {
  const isImage = att.file_type.startsWith('image/');
  const isVideo = att.file_type.startsWith('video/');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  return (
    <>
      {/* `group` + `relative` live on this wrapper, not on the `<a>`, so the delete control is a
          SIBLING of the link rather than a button nested inside an anchor (invalid interactive
          nesting, and its click would have to fight the link's own navigation). */}
      <div className="group relative overflow-hidden rounded-xl border border-border bg-surface-light transition-all hover:border-primary/40 hover:shadow-card">
        <a
          href={att.file_url}
          target="_blank"
          rel="noopener noreferrer"
          download={isImage ? undefined : att.file_name || att.display_name}
          className="block"
          onClick={(e) => {
            if (isVideo) {
              e.preventDefault();
              setVideoUrl(att.file_url);
            }
          }}
        >
          {isImage ? (
            <UploadedImage
              src={att.file_url}
              alt={att.display_name}
              backdrop
              className="h-28 w-full"
              imgClassName="transition-transform duration-200 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="flex h-28 w-full items-center justify-center bg-background-light text-text-secondary">
              {isVideo ? <Film className="h-6 w-6" /> : <FileTextIcon className="h-6 w-6" />}
            </div>
          )}
          {(att.source === 'WALKTHROUGH' || att.context === 'WALKTHROUGH') && (
            <span className="absolute left-1 top-1 rounded-full bg-info/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-info">
              Walkthrough
            </span>
          )}
          <div className="px-2 py-1.5">
            <p className="text-[11px] font-medium text-text-primary truncate">{att.display_name}</p>
            {att.description && (
              <p className="text-[10px] text-text-secondary truncate" title={att.description}>
                {att.description}
              </p>
            )}
          </div>
        </a>
        {onDelete && (
          // The pill chrome and the hover-reveal live on this WRAPPER, not in the Button's
          // className: per the layering guard, a primitive's appearance is decided inside the
          // primitive. The chrome belongs to the wrapper anyway - it exists to lift the control
          // off the photo underneath it, which is a property of the tile, not of the button.
          <div className="absolute right-1 top-1 overflow-hidden rounded-full bg-surface-light/90 opacity-0 shadow ring-1 ring-border transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <Button
              variant="ghost"
              tone="danger"
              revealOnHover
              size="icon"
              disabled={deleting}
              onClick={() => onDelete(att)}
              aria-label={`Delete ${att.display_name}`}
              title="Delete attachment"
              className="h-6 w-6"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      <VideoPreviewDialog url={videoUrl} onClose={() => setVideoUrl(null)} />
    </>
  );
}

export function AttachmentsTabBody({
  jobId,
  attachments,
}: {
  jobId: string;
  attachments: AttachmentItem[] | undefined;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const deleteAttachment = useDeleteJobAttachment(jobId);
  const { confirm, confirmDialog } = useConfirm();

  const handleDelete = async (att: AttachmentItem) => {
    if (await confirm(deleteAttachmentPrompt(att.display_name))) {
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
      if (dropZoneInputRef.current) dropZoneInputRef.current.value = '';
    }
  };

  const handleDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    handleUpload(e.dataTransfer.files);
  };

  const all = attachments ?? [];

  const photos = all.filter(
    (a) => a.file_type.startsWith('image/') && a.source !== 'WALKTHROUGH' && a.context !== 'WALKTHROUGH'
  );
  const walkthroughPhotos = all.filter(
    (a) => a.file_type.startsWith('image/') && (a.source === 'WALKTHROUGH' || a.context === 'WALKTHROUGH')
  );
  const docs = all.filter(
    (a) => !a.file_type.startsWith('image/') && a.source !== 'WALKTHROUGH' && a.context !== 'WALKTHROUGH'
  );
  const walkthroughDocs = all.filter(
    (a) => !a.file_type.startsWith('image/') && (a.source === 'WALKTHROUGH' || a.context === 'WALKTHROUGH')
  );

  const walkthrough = [...walkthroughPhotos, ...walkthroughDocs];

  const uploadControl = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_UPLOAD_TYPES}
        className="hidden"
        id="attachments-tab-upload"
        onChange={(e) => handleUpload(e.target.files)}
      />
      {/* Not a FormField target: this label wraps a Button trigger for a hidden
          file input, not description text for a visible field - no hint/error/
          required concept applies, same shape as the drop-zone label below. */}
      <label htmlFor="attachments-tab-upload">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          className="cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
      </label>
    </>
  );

  if (all.length === 0) {
    return (
      <SectionCard
        title="Attachments"
        icon={<ImageIcon className="h-4 w-4 text-text-secondary" />}
        meta={uploadControl}
      >
        {/* Self-contained drop-zone: its own hidden input (implicit label
            association — no htmlFor) so the header Upload button + its input
            keep working independently, with no duplicate DOM ids. */}
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            'flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed py-12 text-center transition-colors',
            isDragging
              ? 'border-primary bg-primary-subtle'
              : 'border-border hover:border-primary/50 hover:bg-background-light'
          )}
        >
          <input
            ref={dropZoneInputRef}
            type="file"
            multiple
            accept={ACCEPTED_UPLOAD_TYPES}
            className="hidden"
            id="attachments-empty-drop-zone-upload"
            onChange={(e) => handleUpload(e.target.files)}
          />
          <ImageIcon className="mb-2 h-8 w-8 text-text-secondary/30" />
          <p className="text-sm font-medium text-text-primary">
            Drag &amp; drop files here, or click to upload
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {uploading ? 'Uploading…' : 'No attachments yet'}
          </p>
        </label>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Attachments"
      icon={<ImageIcon className="h-4 w-4 text-text-secondary" />}
      meta={uploadControl}
      bodyClassName="space-y-6"
    >
      {photos.length > 0 && docs.length > 0 ? (
        // Both present → Photos and Documents sit side-by-side to save vertical
        // space (instead of two stacked full-width rows). Each column scrolls the
        // whole set — nothing is capped, so 20+ items all render.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <SectionLabel>Photos ({photos.length})</SectionLabel>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {photos.map((a) => (
                <AttachmentTile key={a.id} att={a} onDelete={handleDelete} deleting={deleteAttachment.isPending} />
              ))}
            </div>
          </div>
          <div>
            <SectionLabel>Documents ({docs.length})</SectionLabel>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {docs.map((a) => (
                <AttachmentTile key={a.id} att={a} onDelete={handleDelete} deleting={deleteAttachment.isPending} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          {photos.length > 0 && (
            <div>
              <SectionLabel>Photos ({photos.length})</SectionLabel>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {photos.map((a) => (
                  <AttachmentTile key={a.id} att={a} onDelete={handleDelete} deleting={deleteAttachment.isPending} />
                ))}
              </div>
            </div>
          )}
          {docs.length > 0 && (
            <div>
              <SectionLabel>Documents ({docs.length})</SectionLabel>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {docs.map((a) => (
                  <AttachmentTile key={a.id} att={a} onDelete={handleDelete} deleting={deleteAttachment.isPending} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {walkthrough.length > 0 && (
        <div>
          <SectionLabel>From walkthrough ({walkthrough.length})</SectionLabel>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {/* No `onDelete`: a walkthrough photo is evidence captured on site,
                not a file someone attached, so it is not the job page's to
                remove. Same omission staging shipped. */}
            {walkthrough.map((a) => (
              <AttachmentTile key={a.id} att={a} />
            ))}
          </div>
        </div>
      )}
      {confirmDialog}
    </SectionCard>
  );
}

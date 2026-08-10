import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { ChevronDown, ChevronRight, Plus, Trash2, FileText, Film, Image as ImageIcon, Upload } from 'lucide-react';
import api from '@/lib/axios';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { AttachmentLightbox } from '@/components/ui/AttachmentLightbox';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteAttachmentPrompt } from '@/lib/confirmPrompts';
import { EmptyState } from '@/components/ui/empty-state';

interface AttachmentsPanelProps {
  entityType: string;
  entityId: string;
}

interface Attachment {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  file_size: number;
  display_name: string;
  description: string;
  context: string;
  created_at: string;
  uploader: { id: string; first_name: string; last_name: string };
}

interface ContextConfig {
  key: string;
  label: string;
  badgeColor: string;
}

const CONTEXTS: ContextConfig[] = [
  { key: 'WALKTHROUGH', label: 'Site Visit', badgeColor: 'bg-info-surface text-info-text' },
  { key: 'JOB_WORK', label: 'Job Documentation', badgeColor: 'bg-info-surface text-info-text' },
  { key: 'ESTIMATE', label: 'Estimate', badgeColor: 'bg-info-surface text-info-text' },
  { key: 'OTHER', label: 'Other', badgeColor: 'bg-neutral-surface text-neutral-text' },
];

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/heic,video/mp4,application/pdf';

function FileIcon({ fileType }: { fileType: string }) {
  if (fileType.startsWith('image/')) return <ImageIcon className="h-4 w-4" />;
  if (fileType.startsWith('video/')) return <Film className="h-4 w-4" />;
  return <FileText className="h-4 w-4" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsPanel({ entityType, entityId }: AttachmentsPanelProps) {
  const queryClient = useQueryClient();
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    WALKTHROUGH: true,
    JOB_WORK: true,
    ESTIMATE: true,
    OTHER: true,
  });
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [pendingPreviews, setPendingPreviews] = useState<Record<string, string>>({});
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [lightboxAttachment, setLightboxAttachment] = useState<Attachment | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const emptyStateInputRef = useRef<HTMLInputElement | null>(null);

  const entityTypeLower = entityType.toLowerCase();

  // Fetch attachments
  const { data: attachments, isLoading } = useQuery({
    queryKey: ['attachments', entityType, entityId],
    queryFn: async () => {
      const { data } = await api.get(`/api/attachments/${entityTypeLower}/${entityId}`);
      return data.attachments as Attachment[];
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (attachmentId: string) => {
      await api.delete(`/api/attachments/${entityTypeLower}/${entityId}/${attachmentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
    },
  });

  /**
   * Shared by the row trash button and the lightbox's delete control, so both prompt with the
   * same wording. The lightbox variant additionally closes the overlay, but only after the
   * request resolves - closing on click would dismiss the viewer even when the delete failed.
   */
  const confirmDelete = async (attachment: Attachment, onDeleted?: () => void) => {
    if (!(await confirm(deleteAttachmentPrompt(attachment.display_name)))) return;
    deleteMutation.mutate(attachment.id, { onSuccess: onDeleted });
  };

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleUpload = async (context: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0] as File;

    // Generate client-side preview for images (#33)
    let previewUrl: string | undefined;
    if (file.type.startsWith('image/')) {
      previewUrl = URL.createObjectURL(file);
      setPendingPreviews((prev) => ({ ...prev, [context]: previewUrl! }));
    }

    setUploading((prev) => ({ ...prev, [context]: true }));
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('display_name', file.name.replace(/\.[^/.]+$/, ''));
      formData.append('description', '');
      formData.append('context', context);

      await api.post(`/api/attachments/${entityTypeLower}/${entityId}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
    } catch {
      // Error is visible via the mutation pattern; for panel quick-upload we just stop spinner
    } finally {
      setUploading((prev) => ({ ...prev, [context]: false }));
      // Revoke the object URL to free memory (#33)
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPendingPreviews((prev) => {
          const next = { ...prev };
          delete next[context];
          return next;
        });
      }
      // Reset the file input
      const input = fileInputRefs.current[context];
      if (input) input.value = '';
      if (emptyStateInputRef.current) emptyStateInputRef.current.value = '';
    }
  };

  // Group attachments by context
  const grouped: Record<string, Attachment[]> = {
    WALKTHROUGH: [],
    JOB_WORK: [],
    ESTIMATE: [],
    OTHER: [],
  };
  if (attachments) {
    for (const att of attachments) {
      const key = att.context in grouped ? att.context : 'OTHER';
      grouped[key]!.push(att);
    }
  }

  if (isLoading) {
    return (
      <div className="p-3 space-y-4">
        {[1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    );
  }

  const totalCount = attachments?.length ?? 0;

  return (
    <div className="p-3">
      <p className="text-[10px] text-text-secondary uppercase tracking-wider font-semibold mb-3">
        {totalCount} attachment{totalCount !== 1 ? 's' : ''}
      </p>

      <div className="space-y-2">
        {CONTEXTS.map(({ key, label, badgeColor }) => {
          const items = grouped[key] ?? [];
          const isExpanded = expandedSections[key];
          const isUploading = uploading[key] ?? false;

          // Only show section if it has items
          if (items.length === 0 && !isUploading) return null;

          return (
            <div key={key} className="rounded-lg border border-border overflow-hidden">
              {/* Section header - accordion row with heterogeneous nested content
                  (icon + badge + count + a second, nested trigger below), not
                  Button-shaped - left raw. */}
              <button
                type="button"
                className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-background-light/50 transition-colors"
                onClick={() => toggleSection(key)}
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-text-secondary shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-text-secondary shrink-0" />
                )}
                <span className={cn('text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-full', badgeColor)}>
                  {label}
                </span>
                <span className="text-xs text-text-secondary ml-auto">{items.length}</span>
                {/* Small icon-only upload trigger nested inside the header's own button
                    (pre-existing structure), not Button-shaped - left raw. */}
                <button
                  type="button"
                  aria-label={`Upload to ${label}`}
                  className="flex items-center justify-center h-5 w-5 rounded hover:bg-background-light text-text-secondary transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    fileInputRefs.current[key]?.click();
                  }}
                  title={`Upload to ${label}`}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
                <Input
                  ref={(el) => { fileInputRefs.current[key] = el; }}
                  type="file"
                  accept={ACCEPTED_TYPES}
                  className="hidden"
                  onChange={(e) => handleUpload(key, e.target.files)}
                />
              </button>

              {/* Section content */}
              {isExpanded && (
                <div className="border-t border-border">
                  {isUploading && (
                    <div className="px-3 py-2 flex items-center gap-2 bg-primary/5">
                      {pendingPreviews[key] ? (
                        <UploadedImage
                          src={pendingPreviews[key]}
                          alt="Preview"
                          radius="sm"
                          edge="border"
                          className="h-10 w-10 shrink-0"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded bg-background-light border border-border flex items-center justify-center shrink-0">
                          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        </div>
                      )}
                      <div>
                        <span className="text-xs text-text-secondary">Uploading...</span>
                        {pendingPreviews[key] && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {items.map((att) => (
                    <div
                      key={att.id}
                      className="group flex items-start gap-2 px-3 py-2 hover:bg-background-light/50 transition-colors border-b border-border/50 last:border-b-0"
                    >
                      {/* Thumbnail or icon */}
                      <a
                        href={att.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0"
                        onClick={(e) => {
                          if (att.file_type.startsWith('video/')) {
                            e.preventDefault();
                            setVideoUrl(att.file_url);
                          } else if (att.file_type.startsWith('image/')) {
                            e.preventDefault();
                            setLightboxAttachment(att);
                          }
                        }}
                      >
                        {att.file_type.startsWith('image/') ? (
                          <UploadedImage
                            src={att.file_url}
                            alt={att.display_name}
                            radius="sm"
                            edge="border"
                            className="h-10 w-10"
                          />
                        ) : (
                          <div className="flex items-center justify-center h-10 w-10 rounded bg-background-light border border-border text-text-secondary">
                            <FileIcon fileType={att.file_type} />
                          </div>
                        )}
                      </a>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <a
                          href={att.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-medium text-text-primary hover:text-primary truncate block"
                          onClick={(e) => {
                            if (att.file_type.startsWith('video/')) {
                              e.preventDefault();
                              setVideoUrl(att.file_url);
                            } else if (att.file_type.startsWith('image/')) {
                              e.preventDefault();
                              setLightboxAttachment(att);
                            }
                          }}
                        >
                          {att.display_name}
                        </a>
                        {att.description && (
                          <p className="text-[10px] text-text-secondary truncate">{att.description}</p>
                        )}
                        <p className="text-[10px] text-text-secondary">
                          {att.uploader.first_name} {att.uploader.last_name} &middot;{' '}
                          {formatDistanceToNow(new Date(att.created_at), { addSuffix: true })} &middot;{' '}
                          {formatFileSize(att.file_size)}
                        </p>
                      </div>

                      {/* Delete button - small row-action icon with a group-hover:opacity
                          reveal, not Button-shaped - left raw. */}
                      <button
                        type="button"
                        aria-label="Delete attachment"
                        className="shrink-0 flex items-center justify-center h-6 w-6 rounded text-text-secondary hover:text-danger hover:bg-danger/10 opacity-0 group-hover:opacity-100 transition-all"
                        onClick={() => void confirmDelete(att)}
                        title="Delete attachment"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Empty state (#25 — show a real upload button) */}
        {totalCount === 0 && Object.values(uploading).every((v) => !v) && (
          <EmptyState density="compact"
            title="No attachments yet"
            description="Upload your first file to get started."
           
            action={
              <>
                {/* solid/brand matches the bg-primary fill and text-on-fill label.
                    Two disclosed, not-restored deltas: the raw's text-xs font-medium
                    becomes the primitive's base font-semibold (bolder), and its
                    hover:bg-primary/90 becomes solid/brand's own hover:bg-primary-dark
                    (a different token, close but not identical). No exact size match
                    either: original px-3 py-1.5 had no explicit height and a gap-1.5
                    (vs Button's base gap-2) - nearest rung is 3xs (h-6/px-2/text-xs). */}
                <Button
                  type="button"
                  size="3xs"
                  onClick={() => emptyStateInputRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload file
                </Button>
                <Input
                  ref={emptyStateInputRef}
                  type="file"
                  accept={ACCEPTED_TYPES}
                  className="hidden"
                  onChange={(e) => handleUpload('WALKTHROUGH', e.target.files)}
                />
              </>
            }
          />
        )}
      </div>

      <VideoPreviewDialog url={videoUrl} onClose={() => setVideoUrl(null)} />
      <AttachmentLightbox
        url={lightboxAttachment?.file_url ?? null}
        caption={lightboxAttachment?.display_name}
        uploadedBy={
          lightboxAttachment
            ? `${lightboxAttachment.uploader.first_name} ${lightboxAttachment.uploader.last_name}`.trim()
            : undefined
        }
        uploadedAt={lightboxAttachment?.created_at}
        onDelete={
          lightboxAttachment
            ? () => void confirmDelete(lightboxAttachment, () => setLightboxAttachment(null))
            : undefined
        }
        deleting={deleteMutation.isPending}
        onClose={() => setLightboxAttachment(null)}
      />
      {confirmDialog}
    </div>
  );
}

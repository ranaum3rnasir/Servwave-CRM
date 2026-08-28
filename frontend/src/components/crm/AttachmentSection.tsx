import { useState, useRef, useCallback, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { Upload, Trash2, FileText, Film, Image as ImageIcon, X, RotateCcw } from 'lucide-react';
import api from '@/lib/axios';
import { cn, extractApiError } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteAttachmentPrompt } from '@/lib/confirmPrompts';
import { ACCEPTED_UPLOAD_TYPES } from '@/lib/uploadTypes';

interface AttachmentSectionProps {
  entityType: string;
  entityId: string;
  context: 'WALKTHROUGH' | 'JOB_WORK' | 'ESTIMATE' | 'OTHER';
  onCountChange?: (count: number) => void;
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

interface PendingUpload {
  id: string;
  file: File;
  displayName: string;
  description: string;
  progress: number;
  status: 'editing' | 'uploading' | 'done' | 'error';
  errorMessage?: string;
}

const ACCEPTED_TYPES = ACCEPTED_UPLOAD_TYPES;
const MAX_SIZE = 25 * 1024 * 1024;
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

const CONTEXT_BADGES: Record<string, string> = {
  WALKTHROUGH: 'bg-info-surface text-info-text',
  JOB_WORK: 'bg-info-surface text-info-text',
  ESTIMATE: 'bg-info-surface text-info-text',
  OTHER: 'bg-neutral-surface text-neutral-text',
};

function FileIcon({ fileType }: { fileType: string }) {
  if (fileType.startsWith('image/')) return <ImageIcon className="h-5 w-5" />;
  if (fileType.startsWith('video/')) return <Film className="h-5 w-5" />;
  return <FileText className="h-5 w-5" />;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let uploadCounter = 0;

export function AttachmentSection({
  entityType,
  entityId,
  context,
  onCountChange,
}: AttachmentSectionProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dropRef = useRef<HTMLDivElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const entityTypeLower = entityType.toLowerCase();
  const badgeColor = CONTEXT_BADGES[context] || CONTEXT_BADGES.OTHER;

  // Fetch attachments for this entity (all contexts, filter client-side)
  const { data: allAttachments, isLoading } = useQuery({
    queryKey: ['attachments', entityType, entityId],
    queryFn: async () => {
      const { data } = await api.get(`/api/attachments/${entityTypeLower}/${entityId}`);
      return data.attachments as Attachment[];
    },
  });

  const attachments = (allAttachments ?? []).filter((a) => a.context === context);

  // Fire onCountChange whenever attachment count changes
  useEffect(() => {
    onCountChange?.(attachments.length);
  }, [attachments.length, onCountChange]);

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (attachmentId: string) => {
      await api.delete(`/api/attachments/${entityTypeLower}/${entityId}/${attachmentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
    },
  });

  // Handle file selection
  const addFiles = useCallback((files: FileList | File[]) => {
    const newPending: PendingUpload[] = [];
    for (const file of Array.from(files)) {
      const maxSize = file.type.startsWith('video/') ? MAX_VIDEO_SIZE : MAX_SIZE;
      if (file.size > maxSize) continue; // silently skip oversized
      newPending.push({
        id: `pending-${++uploadCounter}`,
        file,
        displayName: file.name.replace(/\.[^/.]+$/, ''),
        description: '',
        progress: 0,
        status: 'editing',
      });
    }
    setPendingUploads((prev) => [...prev, ...newPending]);
  }, []);

  // Upload a single pending file
  const uploadFile = useCallback(
    async (pending: PendingUpload) => {
      setPendingUploads((prev) =>
        prev.map((p) => (p.id === pending.id ? { ...p, status: 'uploading', progress: 0 } : p))
      );

      try {
        const formData = new FormData();
        formData.append('file', pending.file);
        formData.append('display_name', pending.displayName.trim());
        formData.append('description', pending.description.trim());
        formData.append('context', context);

        await api.post(`/api/attachments/${entityTypeLower}/${entityId}`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          onUploadProgress: (progressEvent) => {
            const pct = progressEvent.total
              ? Math.round((progressEvent.loaded * 100) / progressEvent.total)
              : 0;
            setPendingUploads((prev) =>
              prev.map((p) => (p.id === pending.id ? { ...p, progress: pct } : p))
            );
          },
        });

        // Remove from pending on success
        setPendingUploads((prev) => prev.filter((p) => p.id !== pending.id));
        queryClient.invalidateQueries({ queryKey: ['attachments', entityType, entityId] });
      } catch (err) {
        const message = extractApiError(err, 'Upload failed');
        setPendingUploads((prev) =>
          prev.map((p) =>
            p.id === pending.id ? { ...p, status: 'error', errorMessage: message } : p
          )
        );
      }
    },
    [context, entityId, entityType, entityTypeLower, queryClient]
  );

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles]
  );

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        ref={dropRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'rounded-lg border-2 border-dashed p-6 text-center transition-colors cursor-pointer',
          isDragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-background-light/50'
        )}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload className="h-6 w-6 text-text-secondary mx-auto mb-2" />
        <p className="text-sm text-text-secondary">
          Drag & drop files here, or <span className="text-primary font-medium">Browse</span>
        </p>
        <p className="text-[10px] text-text-secondary mt-1">
          JPG, PNG, HEIC, PDF &middot; 25MB max &middot; MP4 &middot; 50MB max
        </p>
        <Input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {/* Pending uploads */}
      {pendingUploads.map((pending) => (
        <div
          key={pending.id}
          className={cn(
            'rounded-lg border p-3 space-y-2',
            pending.status === 'error' ? 'border-danger bg-danger/5' : 'border-border'
          )}
        >
          <div className="flex items-center gap-2">
            <FileIcon fileType={pending.file.type} />
            <span className="text-xs text-text-secondary truncate flex-1">
              {pending.file.name} ({formatFileSize(pending.file.size)})
            </span>
            {/* Small close-X affordance, not Button-shaped - left raw. */}
            <button
              type="button"
              aria-label="Remove pending upload"
              className="text-text-secondary hover:text-danger"
              onClick={() =>
                setPendingUploads((prev) => prev.filter((p) => p.id !== pending.id))
              }
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {pending.status === 'editing' && (
            <>
              <Input
                placeholder="Display name *"
                value={pending.displayName}
                onChange={(e) =>
                  setPendingUploads((prev) =>
                    prev.map((p) =>
                      p.id === pending.id ? { ...p, displayName: e.target.value } : p
                    )
                  )
                }
                size="xs"
              />
              <Input
                placeholder={pending.file.type.startsWith('image/') ? 'Description (optional)' : 'Description *'}
                value={pending.description}
                onChange={(e) =>
                  setPendingUploads((prev) =>
                    prev.map((p) =>
                      p.id === pending.id ? { ...p, description: e.target.value } : p
                    )
                  )
                }
                size="xs"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={
                  !pending.displayName.trim() ||
                  (!pending.file.type.startsWith('image/') && !pending.description.trim())
                }
                onClick={() => uploadFile(pending)}
              >
                Upload
              </Button>
            </>
          )}

          {pending.status === 'uploading' && (
            <div className="space-y-1">
              <div className="w-full h-1.5 bg-background-light rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${pending.progress}%` }}
                />
              </div>
              <p className="text-[10px] text-text-secondary text-center">{pending.progress}%</p>
            </div>
          )}

          {pending.status === 'error' && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-danger">{pending.errorMessage}</p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => uploadFile(pending)}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Retry
              </Button>
            </div>
          )}
        </div>
      ))}

      {/* Gallery */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : attachments.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="group relative rounded-lg border border-border overflow-hidden bg-surface-light"
            >
              {/* Thumbnail */}
              <a
                href={att.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
                title={att.file_type.startsWith('video/') ? 'Play video' : 'Open in new tab'}
                onClick={(e) => {
                  if (att.file_type.startsWith('video/')) {
                    e.preventDefault();
                    setVideoUrl(att.file_url);
                  }
                }}
              >
                {att.file_type.startsWith('image/') ? (
                  <UploadedImage
                    src={att.file_url}
                    alt={att.display_name}
                    backdrop
                    className="w-full h-24"
                  />
                ) : (
                  <div className="w-full h-24 flex items-center justify-center bg-background-light text-text-secondary">
                    <FileIcon fileType={att.file_type} />
                  </div>
                )}
              </a>

              {/* Context badge */}
              <span
                className={cn(
                  'absolute top-1 left-1 text-[8px] font-semibold uppercase px-1 py-0.5 rounded',
                  badgeColor
                )}
              >
                {context.replace('_', ' ')}
              </span>

              {/* Delete button - tiny absolutely-positioned thumbnail-overlay affordance
                  with a group-hover:opacity reveal, not Button-shaped - left raw. */}
              <button
                type="button"
                aria-label="Delete attachment"
                className="absolute top-1 right-1 flex items-center justify-center h-5 w-5 rounded bg-surface-light/80 text-text-secondary hover:text-danger hover:bg-surface-light opacity-0 group-hover:opacity-100 transition-all"
                onClick={async () => {
                  if (await confirm(deleteAttachmentPrompt(att.display_name))) {
                    deleteMutation.mutate(att.id);
                  }
                }}
                title="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>

              {/* Info */}
              <div className="px-2 py-1.5">
                <p className="text-[11px] font-medium text-text-primary truncate">{att.display_name}</p>
                {att.description && (
                  <p className="text-[10px] text-text-secondary truncate" title={att.description}>
                    {att.description}
                  </p>
                )}
                <p className="text-[10px] text-text-secondary">
                  {formatDistanceToNow(new Date(att.created_at), { addSuffix: true })}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <VideoPreviewDialog url={videoUrl} onClose={() => setVideoUrl(null)} />
      {confirmDialog}
    </div>
  );
}

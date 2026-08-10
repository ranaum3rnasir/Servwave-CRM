/**
 * ScopePhotoStrip — R5f. Wires `PhotoAttachmentStrip` to the scope-of-work photo endpoints.
 * `scopeId` must be the block's own stable `Scope.id`, never its array index (the backend routes
 * on that id — see `lib/api/estimates.ts`'s `uploadScopePhoto`/`deleteScopePhoto`). Same
 * invalidate-on-success convention as `LineItemPhotoStrip` (upload/delete never return the whole
 * estimate).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PhotoAttachmentStrip } from './PhotoAttachmentStrip';
import { uploadScopePhoto, deleteScopePhoto, type EstimatePhoto } from '@/lib/api/estimates';

export interface ScopePhotoStripProps {
  estimateId: string;
  scopeId: string;
  photos: EstimatePhoto[];
  canManage: boolean;
}

export function ScopePhotoStrip({ estimateId, scopeId, photos, canManage }: ScopePhotoStripProps) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadScopePhoto(estimateId, scopeId, file),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: (photoId: string) => deleteScopePhoto(estimateId, scopeId, photoId),
    onSuccess: invalidate,
  });

  return (
    <PhotoAttachmentStrip
      photos={photos}
      canManage={canManage}
      itemLabel="scope photo"
      onUpload={(file) => uploadMutation.mutateAsync(file)}
      onDelete={(photoId) => deleteMutation.mutateAsync(photoId)}
    />
  );
}

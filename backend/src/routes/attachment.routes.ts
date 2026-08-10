import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import * as attachmentController from '../controllers/attachment.controller';

const router = Router();
// The 60MB route limit is a generous ceiling ABOVE the handler's real per-kind
// caps (25MB non-video, 50MB video — mirrors estimate.routes.ts's photoUpload
// pattern) so an oversized file 400s with the handler's precise message
// instead of multer's own LIMIT_FILE_SIZE error surfacing as a raw 500.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 },
});

router.use(authenticate, attachAbility);

// List attachments for an entity
router.get('/:entityType/:entityId', canDo('read', 'Attachment'), attachmentController.listAttachments);

// Upload attachment (multipart/form-data: file + display_name + description + context)
// `withOrgContext` re-establishes the org AsyncLocalStorage scope that multer's
// stream consumption drops — without it the controller's queries run org-less
// and RLS 404s with "Entity not found" (DB_TENANT_GUARD=on).
router.post('/:entityType/:entityId', canDo('create', 'Attachment'), upload.single('file'), withOrgContext, attachmentController.uploadAttachment);

// Update attachment metadata (display_name, description)
router.patch('/:entityType/:entityId/:attachmentId', canDo('update', 'Attachment'), validate(attachmentController.updateAttachmentSchema), attachmentController.updateAttachment);

// Delete attachment
router.delete('/:entityType/:entityId/:attachmentId', canDo('delete', 'Attachment'), attachmentController.deleteAttachment);

export default router;

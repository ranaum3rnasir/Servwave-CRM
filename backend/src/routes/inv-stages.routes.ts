import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import * as invStagesController from '../controllers/inv-stages.controller';

const router = Router();

// P5 stage attachments: memoryStorage; the 100MB route limit is the video
// ceiling — the handler applies the tighter 8MB per-kind cap for images.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

router.use(authenticate, requireFeature('inventory'), attachAbility);

// ─── Job Stages ─────────────────────────────────────────
router.get('/job-stages', canDo('read', 'Inventory'), invStagesController.listJobStages);
router.post('/job-stages', canDo('create', 'Inventory'), validate(invStagesController.createStageSchema), invStagesController.createJobStage);
router.get('/job-stages/:id', canDo('read', 'Inventory'), invStagesController.getJobStage);
router.patch('/job-stages/:id', canDo('update', 'Inventory'), validate(invStagesController.updateStageSchema), invStagesController.updateJobStage);
router.post('/job-stages/receive', canDo('update', 'Inventory'), validate(invStagesController.receiveStageSchema), invStagesController.receiveStageLine);
router.post('/job-stages/notify', canDo('update', 'Inventory'), validate(invStagesController.notifyStageSchema), invStagesController.notifyTechReady);
router.post('/job-stages/email', canDo('update', 'Inventory'), validate(invStagesController.emailStageSchema), invStagesController.emailJobStage);

// ─── Stage attachments (P5 §5.2) — multipart: file + caption/source/… text parts ───
// `withOrgContext` MUST sit AFTER multer: multer's stream consumption drops the
// AsyncLocalStorage tenant scope (see attachment.routes.ts / the ALS-drop learning).
router.post('/job-stages/:id/attachments', canDo('update', 'Inventory'), upload.single('file'), withOrgContext, invStagesController.uploadStageAttachment);
router.delete('/job-stages/:id/attachments/:attachmentId', canDo('update', 'Inventory'), invStagesController.deleteStageAttachment);

export default router;

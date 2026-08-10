import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as commController from '../controllers/comm-threads.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// ─── Threads ────────────────────────────────────────────
router.get('/threads', canDo('read', 'Communication'), commController.listThreads);
router.get('/threads/:id', canDo('read', 'Communication'), commController.getThread);
router.post('/threads', canDo('create', 'Communication'), validate(commController.createThreadSchema), commController.createThread);
// Send SMS = append a Message to a thread.
router.post('/sms', canDo('create', 'Communication'), validate(commController.sendMessageSchema), commController.sendMessage);
// One-click reassign of a message's job attribution (job_id: null clears → Unrouted tray).
router.patch('/sms/:id/job', canDo('update', 'Communication'), validate(commController.reassignSmsJobSchema), commController.reassignMessageJob);
// Lead mirror of the job attach (full job-parity ruling, 2026-07-22; lead_id: null clears).
router.patch('/sms/:id/lead', canDo('update', 'Communication'), validate(commController.reassignMessageLeadSchema), commController.reassignMessageLead);

// ─── Templates ──────────────────────────────────────────
router.get('/templates', canDo('read', 'Communication'), commController.listTemplates);
router.post('/templates', canDo('create', 'Communication'), validate(commController.createTemplateSchema), commController.createTemplate);
router.get('/templates/:id', canDo('read', 'Communication'), commController.getTemplate);
router.patch('/templates/:id', canDo('update', 'Communication'), validate(commController.updateTemplateSchema), commController.updateTemplate);
router.delete('/templates/:id', canDo('delete', 'Communication'), commController.deleteTemplate);

// ─── Automations ────────────────────────────────────────
router.get('/automations', canDo('read', 'Communication'), commController.listAutomations);
router.post('/automations', canDo('create', 'Communication'), validate(commController.createAutomationSchema), commController.createAutomation);
router.get('/automations/:id', canDo('read', 'Communication'), commController.getAutomation);
router.patch('/automations/:id', canDo('update', 'Communication'), validate(commController.updateAutomationSchema), commController.updateAutomation);
router.delete('/automations/:id', canDo('delete', 'Communication'), commController.deleteAutomation);

export default router;

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { expensiveLimiter } from '../middleware/rate-limit';
import * as leadController from '../controllers/lead.controller';
import * as jobCommunicationsController from '../controllers/job-communications.controller';
import * as tagController from '../controllers/tag.controller';

const router = Router();

router.use(authenticate, requireFeature('leads'), attachAbility);

// Stats & lookups (before :id to avoid route conflict)
router.get('/stats', canDo('read', 'Lead'), leadController.getStats);
// Filter-aware "export all" — gated `read` (no `export` action for Lead); reuses list row-scope.
router.get('/export', expensiveLimiter, canDo('read', 'Lead'), leadController.exportAll);

// CRUD
router.get('/', canDo('read', 'Lead'), leadController.list);
router.post('/', canDo('create', 'Lead'), validate(leadController.createLeadSchema), leadController.create);
router.get('/:id', canDo('read', 'Lead'), leadController.getById);
router.patch('/:id', canDo('update', 'Lead'), validate(leadController.updateLeadSchema), leadController.update);
router.delete('/:id', canDo('delete', 'Lead'), leadController.remove);

// Notes
router.get('/:id/notes', canDo('read', 'Lead'), leadController.getNotes);
router.post('/:id/notes', canDo('update', 'Lead'), validate(leadController.createLeadNoteSchema), leadController.addNote);

// Communications (Communication ↔ Leads — lead_id ∪ customer_id union roll-up)
router.get('/:id/communications', canDo('read', 'Communication'), jobCommunicationsController.getLeadCommunications);
// Timeline (#585)
router.get('/:id/timeline', canDo('read', 'Lead'), leadController.getTimeline);

// Actions
router.post('/:id/assign', canDo('assign', 'Lead'), validate(leadController.assignLeadSchema), leadController.assign);
// POST /:id/contact removed (D6, PR-B2): contacted_at is inferred from outbound activity,
// never set by hand - the handler + schema were deleted from lead.controller.ts.
router.post('/:id/mark-lost', canDo('mark_lost', 'Lead'), validate(leadController.markLostSchema), leadController.markLost);
router.post('/:id/cancel', canDo('cancel', 'Lead'), validate(leadController.cancelLeadSchema), leadController.cancelLead);

// Walkthrough actions
router.post('/:id/walkthrough', canDo('perform_walkthrough', 'Lead'), validate(leadController.walkthroughSchema), leadController.updateWalkthrough);
router.post('/:id/walkthrough/schedule', canDo('schedule_walkthrough', 'Lead'), validate(leadController.scheduleWalkthroughSchema), leadController.scheduleWalkthrough);
// Performer-only REPLACE (no schedule/status side effects)
router.post('/:id/walkthrough/performers', canDo('schedule_walkthrough', 'Lead'), validate(leadController.setPerformersSchema), leadController.setPerformers);
// Clear the schedule but keep the performers
router.post('/:id/walkthrough/unschedule', canDo('schedule_walkthrough', 'Lead'), leadController.unscheduleWalkthrough);
router.post('/:id/walkthrough/complete', canDo('perform_walkthrough', 'Lead'), leadController.completeWalkthrough);
router.post('/:id/walkthrough/cancel', canDo('cancel', 'Lead'), validate(leadController.cancelWalkthroughSchema), leadController.cancelWalkthrough);

// Tags on leads
router.post('/:id/tags', canDo('update', 'Lead'), validate(tagController.addTagToLeadSchema), tagController.addTagToLead);
router.delete('/:id/tags/:tagId', canDo('update', 'Lead'), tagController.removeTagFromLead);

export default router;

import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as leadStatusOverrideController from '../controllers/leadStatusOverride.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Gating mirrors jobSubStatus.routes.ts: writes reuse the existing `update Organization` grant
// (an org-settings surface, not a new CASL Subject); the read is the coarser `read Lead` since
// every lead viewer needs these labels to render a lead, not just the settings population.
router.get('/', canDo('read', 'Lead'), leadStatusOverrideController.list);
// Literal path segments before any ":status" route, matching jobSubStatus.routes.ts's ordering rule.
router.post('/reorder', canDo('update', 'Organization'), validate(leadStatusOverrideController.reorderLeadStatusOverridesSchema), leadStatusOverrideController.reorder);
router.patch('/:status', canDo('update', 'Organization'), validate(leadStatusOverrideController.updateLeadStatusOverrideSchema), leadStatusOverrideController.update);
router.post('/:status/default', canDo('update', 'Organization'), leadStatusOverrideController.setDefault);

export default router;

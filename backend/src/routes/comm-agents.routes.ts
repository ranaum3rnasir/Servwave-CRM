import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as commAgentsController from '../controllers/comm-agents.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// ─── Phone Agents ───────────────────────────────────────
router.get('/agents', canDo('read', 'Communication'), commAgentsController.listPhoneAgents);
router.get('/agents/:id', canDo('read', 'Communication'), commAgentsController.getPhoneAgent);

// ─── Blocked Numbers ────────────────────────────────────
router.get('/blocked', canDo('read', 'Communication'), commAgentsController.listBlockedNumbers);
router.post('/blocked', canDo('create', 'Communication'), validate(commAgentsController.blockNumberSchema), commAgentsController.blockNumber);
router.post('/blocked/unblock', canDo('delete', 'Communication'), validate(commAgentsController.unblockNumberSchema), commAgentsController.unblockNumber);
router.get('/blocked/:id', canDo('read', 'Communication'), commAgentsController.getBlockedNumber);

// '/forward-rules' moved to comm-email.routes.ts - it reads the email forward
// rules table, so it belongs to `email`, not to PRO `phone`.
// '/team-members' moved to comm-shared.routes.ts - both the email composer and
// the phone call-groups screen read it, so it belongs to neither key alone.
// Their handlers still live in comm-agents.controller.ts.

export default router;

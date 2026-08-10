import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import * as commPhoneAccessController from '../controllers/comm-phone-access.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// Mint a short-lived per-agent CTM softphone token. The embedded WebRTC device
// authenticates with this; the agency Access/Secret keys never reach the browser.
// Floor = `create` Communication, matching POST /calls (comm-calls.routes.ts): a
// softphone ORIGINATES calls, so operating one requires the same authority as
// placing a call through the API — a read-only comm role (e.g. SALES) must not
// gain outbound calling via the device token.
router.post('/phone-access', canDo('create', 'Communication'), commPhoneAccessController.createPhoneAccessToken);

export default router;

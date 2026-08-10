import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as commNumbersController from '../controllers/comm-numbers.controller';
import * as commMyNumberController from '../controllers/comm-my-number.controller';

const router = Router();

router.use(authenticate, requireFeature('phone'), attachAbility);

// "My outbound number" (master plan Task B1): the /phone tab's caller-ID
// resolver for the current user. Gated on canDo('create','Communication') —
// the role-agnostic phone-access grant (Task A0's shared baseline) — rather
// than 'read', since TECHNICIAN etc. don't hold read Communication by default
// but must still be able to dial from their resolved number.
router.get('/my-outbound-number', canDo('create', 'Communication'), commMyNumberController.getMyOutboundNumber);

// "My numbers" (master plan Task B3): the /phone tab's caller-ID PICKER
// allow-list — the current user's own assigned numbers + the org default,
// never the full org roster (that's the ADMIN-gated /number-assignments
// endpoint). Same role-agnostic phone-access gate as /my-outbound-number.
router.get('/my-numbers', canDo('create', 'Communication'), commMyNumberController.getMyNumbers);

// ─── Numbers platform (PhoneNumber) ──────────────────────
// READ/PATCH are plain Communication grants; search/buy/register-byo spend
// money or change org plumbing, so they carry the ADMIN idiom
// canDo('update','Organization') — addendum §A.2 (a Communication gate would
// let DISPATCHER buy numbers).
router.get('/numbers', canDo('read', 'Communication'), commNumbersController.listNumbers);
router.post('/numbers/search', canDo('update', 'Organization'), validate(commNumbersController.searchNumbersSchema), commNumbersController.searchNumbers);
router.post('/numbers/buy', canDo('update', 'Organization'), validate(commNumbersController.buyNumberSchema), commNumbersController.buyNumber);
router.post('/numbers/register-byo', canDo('update', 'Organization'), validate(commNumbersController.registerByoSchema), commNumbersController.registerByoNumber);
// Flow reassign — call_flow_id is the only writable field.
router.patch('/numbers/:id', canDo('update', 'Communication'), validate(commNumbersController.updateNumberSchema), commNumbersController.updateNumber);

export default router;

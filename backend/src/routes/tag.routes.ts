import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as tagController from '../controllers/tag.controller';

const router = Router();

router.use(authenticate, attachAbility);

// Tag CRUD
router.get('/', canDo('read', 'Tag'), tagController.list);
router.post('/', canDo('create', 'Tag'), validate(tagController.createTagSchema), tagController.create);

export default router;

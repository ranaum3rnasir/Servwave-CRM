import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/location.controller';

const router = Router();

router.use(authenticate, attachAbility);
router.get('/', canDo('read', 'Location'), ctrl.listLocations);
router.post('/', canDo('create', 'Location'), validate(ctrl.createLocationSchema), ctrl.createLocation);
router.patch('/:id', canDo('update', 'Location'), validate(ctrl.updateLocationSchema), ctrl.updateLocation);
router.delete('/:id', canDo('delete', 'Location'), ctrl.deleteLocation);

export default router;

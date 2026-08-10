import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/aiFarm.controller';

const router = Router();

// Any authenticated org member can book a call — the AI Agentic Farm catalog is
// visible to every role, so booking isn't gated by a CASL subject.
router.use(authenticate);

router.post('/bookings', validate(ctrl.bookCallSchema), ctrl.bookCall);

export default router;

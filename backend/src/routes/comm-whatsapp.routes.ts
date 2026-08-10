import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { requireDemoOrg } from '../middleware/requireDemoOrg';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as commController from '../controllers/comm-whatsapp-email.controller';

const router = Router();

/**
 * WhatsApp ships LOCKED: PRO `phone` gets you the module, but only the demo org
 * may reach these routes at all. No WhatsApp Business connection model exists in
 * schema.prisma, so for a real org the surface has nothing behind it (the
 * controller's own send path already 409s WHATSAPP_NOT_CONNECTED for a non-demo
 * org - this closes the read paths too, before any query runs).
 *
 * Path-scoped for the same reason as comm-email.routes.ts: a bare router.use()
 * on a shared mount base would 404 every other comm route for a real org.
 * '/whatsapp' covers '/whatsapp/:id'; '/whatsapp-chats' is a separate segment.
 */
const WHATSAPP_PREFIXES = ['/whatsapp', '/whatsapp-chats'];

router.use(
  WHATSAPP_PREFIXES,
  authenticate,
  requireFeature('phone'),
  requireDemoOrg('whatsapp'),
  attachAbility,
);

// ─── WhatsApp ───────────────────────────────────────────
router.get('/whatsapp', canDo('read', 'Communication'), commController.listWhatsAppChats);
router.post('/whatsapp', canDo('create', 'Communication'), validate(commController.sendWhatsAppSchema), commController.sendWhatsApp);
router.get('/whatsapp/:id', canDo('read', 'Communication'), commController.getWhatsAppChat);
router.post('/whatsapp-chats', canDo('create', 'Communication'), validate(commController.createWhatsAppChatSchema), commController.createWhatsAppChat);

// Terminate this router's own prefixes - see the same guard in
// comm-email.routes.ts for why an unmatched path must not walk the mount chain
// into a foreign entitlement gate.
router.all([...WHATSAPP_PREFIXES, '/whatsapp/*', '/whatsapp-chats/*'], (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default router;

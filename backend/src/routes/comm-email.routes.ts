import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { requireFeature } from '../middleware/requireFeature';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import * as commController from '../controllers/comm-whatsapp-email.controller';
import * as commAgentsController from '../controllers/comm-agents.controller';

const router = Router();

// POST /emails is multipart/form-data (email slice 7 - the Resend send path):
// compose fields ride as regular text fields, files ride under `files`. Same
// per-file cap as attachment.routes.ts; `withOrgContext` MUST come immediately
// after multer - multer's stream consumption drops the AsyncLocalStorage tenant
// scope (same ordering as attachment.routes.ts / inv-stages.routes.ts).
const MAX_EMAIL_ATTACHMENTS = 10;
const emailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per file
});

/**
 * Email is its own entitlement (STARTER, on by default for every org) - it used
 * to ride on PRO `phone` along with the rest of the Communication module.
 *
 * The gate is PATH-SCOPED, not a bare `router.use(...)`. Every comm-* router is
 * mounted on the same /api/communication base, so a bare router-level gate runs
 * for EVERY request under that prefix, including paths this router owns no route
 * for - which would then be answered 402 here instead of falling through to the
 * router that does own them. That was invisible while all eight routers gated on
 * the same key; it stops being invisible the moment two keys coexist.
 *
 * '/emails' as a `use` prefix also covers '/emails/:id' and
 * '/emails/thread-read'; it does NOT cover '/email-groups' (segment boundary),
 * hence both entries.
 *
 * '/forward-rules' lives here rather than beside the phone agents because
 * listForwardRules reads the email_forward_rules table - it is email data that
 * happened to be declared next to the telephony routes.
 */
const EMAIL_PREFIXES = ['/emails', '/email-groups', '/forward-rules', '/sending-identity'];

router.use(EMAIL_PREFIXES, authenticate, requireFeature('email'), attachAbility);

// ─── Sending identity ───────────────────────────────────
// The From a send would carry, resolved without sending, so the compose window
// can name it. Its own prefix rather than a path under '/emails' - '/emails' as
// a `use` prefix would cover it, but GET '/emails/:id' would then swallow the
// route itself (the same ordering trap '/emails/thread-read' already has a
// regression test for).
router.get('/sending-identity', canDo('read', 'Communication'), commController.getSendingIdentity);

// ─── Email groups ───────────────────────────────────────
router.get('/email-groups', canDo('read', 'Communication'), commController.listEmailGroups);

// ─── Forward rules ──────────────────────────────────────
router.get('/forward-rules', canDo('read', 'Communication'), commAgentsController.listForwardRules);

// ─── Emails ─────────────────────────────────────────────
router.get('/emails', canDo('read', 'Communication'), commController.listEmails);
router.post(
  '/emails',
  canDo('create', 'Communication'),
  emailUpload.array('files', MAX_EMAIL_ATTACHMENTS),
  withOrgContext,
  validate(commController.sendEmailSchema),
  commController.sendEmail,
);
// MUST stay above '/emails/:id' - a literal path registered after a param route
// on the same method+prefix is swallowed by the param route.
router.patch('/emails/thread-read', canDo('update', 'Communication'), validate(commController.markThreadReadSchema), commController.markThreadRead);
// Email slice 8b - conversation assignment + shared archive/snooze. These have
// MORE path segments than '/emails/:id' (which matches exactly one segment
// after '/emails/'), so they never collide with it regardless of registration
// order - kept up here anyway, beside thread-read, since they are the other
// thread-level (not per-message) mutations.
router.patch('/emails/threads/:id/assign', canDo('update', 'Communication'), validate(commController.assignEmailThreadSchema), commController.assignEmailThread);
router.patch('/emails/threads/:id/archive', canDo('update', 'Communication'), validate(commController.archiveEmailThreadSchema), commController.archiveEmailThread);
router.patch('/emails/threads/:id/snooze', canDo('update', 'Communication'), validate(commController.snoozeEmailThreadSchema), commController.snoozeEmailThread);
// "Attach from this record" (email slice 7) - MUST also stay above '/emails/:id'
// for the same reason as thread-read above: a literal path is swallowed by a
// param route registered before it.
router.get('/emails/attach-source', canDo('read', 'Communication'), commController.listAttachSources);
// Email slice 6 - the unmatched inbound queue. Literal path, so it MUST stay
// above '/emails/:id' for the same reason as thread-read and attach-source:
// registered after the param route, 'unmatched' is swallowed as an id.
router.get('/emails/unmatched', canDo('read', 'Communication'), commController.listUnmatchedEmails);
// One-click reassign of an email's job attribution (job_id: null clears) - the
// email mirror of PATCH /sms/:id/job.
router.patch('/emails/:id/job', canDo('update', 'Communication'), validate(commController.reassignEmailJobSchema), commController.reassignEmailJob);
// Email slice 6 - manually attach an unmatched inbound message to a thread. A
// deeper path than '/emails/:id', so it never collides with the param route.
router.patch('/emails/:id/link', canDo('update', 'Communication'), validate(commController.linkInboundEmailSchema), commController.linkInboundEmail);
router.get('/emails/:id', canDo('read', 'Communication'), commController.getEmail);
// Mint a fresh signed URL for one attachment (email slice 7) - a deeper path
// than '/emails/:id' so it never collides with the param route above.
router.get('/emails/:id/attachments/:index', canDo('read', 'Communication'), commController.getEmailAttachmentUrl);

/**
 * Terminate this router's own prefixes.
 *
 * Without this, a request to a path under /emails that matches no route above
 * (a wrong method, a typo, a retired endpoint) exits this router and keeps
 * walking the mount chain until it reaches a comm-* router whose bare
 * router.use() gate answers 402 FEATURE_NOT_IN_PLAN for `phone`. An email-only
 * org would then get a Pro upsell for a telephony module it never touched.
 * These prefixes belong to this router, so an unmatched path under them is a
 * 404, not somebody else's entitlement problem.
 */
router.all([...EMAIL_PREFIXES, '/emails/*', '/email-groups/*', '/forward-rules/*'], (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default router;

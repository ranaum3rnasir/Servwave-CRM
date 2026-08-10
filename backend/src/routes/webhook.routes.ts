import { Router } from 'express';
import express from 'express';
import * as webhookController from '../controllers/webhook.controller';
import * as ctmWebhookController from '../controllers/ctm-webhook.controller';
import * as resendWebhookController from '../controllers/resend-webhook.controller';

const router = Router();

// Stripe requires raw body for signature verification
router.post('/stripe', express.raw({ type: 'application/json' }), webhookController.handleStripeWebhook);
// CTM sends JSON with drifting content-types; raw body is kept for the
// X-CTM-Signature HMAC (verified over the exact bytes).
router.post('/ctm/:position', express.raw({ type: '*/*' }), ctmWebhookController.handleCtmWebhook);
// Email slice 4 — Resend delivery webhook (email.sent/delivered/bounced/…).
// Raw body kept for resend.webhooks.verify()'s svix-based signature check.
router.post('/resend', express.raw({ type: 'application/json' }), resendWebhookController.handleResendWebhook);

export default router;

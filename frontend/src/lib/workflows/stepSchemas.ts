/**
 * stepSchemas.ts — RHF/Zod resolvers for the per-step config forms, a 1:1 mirror
 * of the backend per-step schemas (backend/src/services/automations/
 * workflowValidation.ts). Same bounds, same cross-field rules (custom⇒email,
 * specific_user⇒user_id, condition non-empty) so what a form flags inline is
 * exactly what the server would flag as a "needs setup" issue — only the copy is
 * humanized. The recipient/merge-field *legality* checks stay server-owned
 * (they depend on the trigger's entity, which the amber "changing the trigger"
 * callout warns about) — the forms only offer legal recipients + legal chips.
 *
 * `custom_email`/`user_id` are modelled as plain optional strings (not
 * `.email()`/`.uuid()` at the field level) so the form's empty-string default
 * never spuriously errors; format/required is enforced in `superRefine` only
 * when the recipient actually calls for it — matching how the backend splits the
 * base schema from `validateWorkflowDefinition`'s companion-field checks.
 */

import { z } from 'zod';

/** 90 days in minutes — the shared timing ceiling (mirrors MAX_OFFSET_MINUTES). */
const MAX_WAIT_MINUTES = 60 * 24 * 90;

/** Loose email shape — same pattern the legacy editor used for custom recipients. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * v2.1 multi-select normalization (mirrors the backend's `normalizeMessagingConfig`).
 * A messaging step now carries `recipients: RecipientKey[]`, but legacy stored
 * configs — and the current single-Select forms — still speak the singular
 * `recipient`/`custom_email`/`user_id`. This preprocess synthesizes the array
 * fields from the singular ones (when absent) so both the array shape AND the
 * legacy singular shape parse. The singular fields are KEPT (not dropped) so the
 * inferred form-value types still expose them and the existing forms compile
 * unchanged — the multi-select UI migration is a later task.
 */
function withRecipientsArray(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const v: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (!('recipients' in v) && typeof v.recipient === 'string') v.recipients = [v.recipient];
  if (!('custom_emails' in v) && typeof v.custom_email === 'string' && v.custom_email.trim()) {
    v.custom_emails = [v.custom_email];
  }
  if (!('user_ids' in v) && typeof v.user_id === 'string' && v.user_id.trim()) v.user_ids = [v.user_id];
  return v;
}

/** Merge fields referenced in a piece of copy — same regex as the backend validator. */
export const MERGE_FIELD_RE = /\{\{([a-z_.]+)\}\}/g;
export function mergeFieldsIn(text: string): string[] {
  return [...text.matchAll(MERGE_FIELD_RE)].map((m) => m[1] as string);
}

// ── per-step config schemas ─────────────────────────────────────────────────

/**
 * WAIT has two modes, mirroring the backend union in workflowValidation.ts:
 * relative ("wait 2 days") or anchored to an entity date ("wait until 1 day
 * before the walkthrough" — see lib/workflows/anchors.ts for the legal anchor
 * keys). `anchor`'s literal tuple must stay in sync with `AnchorKey` there —
 * same split the backend keeps between anchors.ts (the registry) and
 * workflowValidation.ts (the schema literal).
 */
export const waitRelativeConfigSchema = z
  .object({
    mode: z.literal('relative'),
    duration_minutes: z
      .number({ invalid_type_error: 'Set how long to wait' })
      .int('Use a whole number of minutes')
      .min(5, 'Wait at least 5 minutes')
      .max(MAX_WAIT_MINUTES, 'That’s longer than the 90-day limit'),
  })
  .strict();

export const waitAnchoredConfigSchema = z
  .object({
    mode: z.literal('anchored'),
    anchor: z.enum(['job.scheduled_start', 'lead.walkthrough_scheduled_at']),
    direction: z.enum(['before', 'after']),
    offset_minutes: z
      .number({ invalid_type_error: 'Set the timing' })
      .int('Use a whole number of minutes')
      .min(0, 'Timing can’t be negative')
      .max(MAX_WAIT_MINUTES, 'That’s longer than the 90-day limit'),
  })
  .strict();

// Legacy relative configs (persisted before anchored wait shipped) have no `mode`
// key — default it so discriminatedUnion can route them, giving proper field-level
// error paths (invalid duration → path 'duration_minutes', not a path-less union
// error). Mirrors the backend's identical preprocess in workflowValidation.ts.
export const waitConfigSchema = z.preprocess(
  (val) => (val && typeof val === 'object' && !('mode' in (val as object)) ? { mode: 'relative', ...(val as object) } : val),
  z.discriminatedUnion('mode', [waitRelativeConfigSchema, waitAnchoredConfigSchema]),
);

// Recipient element enums stay action-scoped (the legacy sets the single-Select
// forms + the catalog offer today). Task 19 adds the `recipients[]` array over
// these same keys; the 9-audience expansion is a later, forms-side task.
const EMAIL_RECIPIENT = z.enum(['customer', 'assigned_techs', 'all_admins', 'all_dispatchers', 'custom']);
const NOTIFY_RECIPIENT = z.enum(['assigned_techs', 'all_admins', 'all_dispatchers', 'specific_user']);

export const sendTextConfigSchema = z.preprocess(
  withRecipientsArray,
  z
    .object({
      recipient: z.literal('customer').optional(),
      recipients: z.array(z.literal('customer')).min(1),
      body: z.string().min(1, 'Write the text message').max(320, 'Texts are capped at 320 characters'),
    })
    .strict(),
);

export const sendEmailConfigSchema = z.preprocess(
  withRecipientsArray,
  z
    .object({
      recipient: EMAIL_RECIPIENT.optional(),
      recipients: z.array(EMAIL_RECIPIENT).min(1),
      subject: z.string().min(1, 'Add a subject line').max(200, 'Subject is too long (200 characters max)'),
      body: z.string().min(1, 'Write the email').max(5000, 'Email is too long (5,000 characters max)'),
      custom_email: z.string().optional(),
      custom_emails: z.array(z.string()).optional(),
    })
    .strict()
    .superRefine((cfg, ctx) => {
      if (cfg.recipient !== 'custom') return;
      const email = (cfg.custom_email ?? '').trim();
      if (!email) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['custom_email'], message: 'Enter the email address to send to' });
      } else if (!EMAIL_RE.test(email)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['custom_email'], message: 'Enter a valid email address' });
      }
    }),
);

export const notifyTeamConfigSchema = z.preprocess(
  withRecipientsArray,
  z
    .object({
      recipient: NOTIFY_RECIPIENT.optional(),
      recipients: z.array(NOTIFY_RECIPIENT).min(1),
      body: z.string().min(1, 'Write the message').max(5000, 'Message is too long (5,000 characters max)'),
      user_id: z.string().optional(),
      user_ids: z.array(z.string()).optional(),
    })
    .strict()
    .superRefine((cfg, ctx) => {
      if (cfg.recipient === 'specific_user' && !(cfg.user_id ?? '').trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['user_id'], message: 'Pick the team member to notify' });
      }
    }),
);

export const stopIfConfigSchema = z.object({ condition: z.string().min(1, 'Pick a condition') }).strict();

// ── inferred form-value types ────────────────────────────────────────────────

export type WaitFormValues = z.infer<typeof waitConfigSchema>;
export type SendTextFormValues = z.infer<typeof sendTextConfigSchema>;
export type SendEmailFormValues = z.infer<typeof sendEmailConfigSchema>;
export type NotifyTeamFormValues = z.infer<typeof notifyTeamConfigSchema>;
export type StopIfFormValues = z.infer<typeof stopIfConfigSchema>;

export type EmailRecipient = SendEmailFormValues['recipient'];
export type NotifyRecipient = NotifyTeamFormValues['recipient'];

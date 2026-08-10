/**
 * defaultAutomations.ts — the built-in automations seeded into every org,
 * each one standing in for a hard-coded email (backend/src/lib/email.ts).
 * Content is a straight port of that sender's real subject/body, rewritten
 * with merge-field tokens — not new copy. See
 * md_files/plans/automations/2026-07-21-hardcoded-to-automation-center-migration.md
 * for which built-in sender each entry retires. This registry only supplies
 * what the seeder (seedDefaultAutomations.ts) writes — nothing here deletes a
 * hard-coded sender. That cutover is a separate, later change per event.
 *
 * builtin_key is prefixed `default-` to stay visually distinct from the
 * unrelated gallery `template_key` namespace: template_key records
 * PROVENANCE ("copied from this gallery template", and a template may be
 * copied more than once), builtin_key records IDENTITY ("is the org's one
 * copy of built-in X") — see the schema comment on Workflow.builtin_key.
 */
import type { AutomationTriggerType } from '@prisma/client';
import type { RecipientKey } from './recipients';

export interface DefaultAutomation {
  builtin_key: string;
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  recipients: RecipientKey[];
  subject: string;
  body: string;
  /**
   * Whether this default lands switched ON when seeded.
   *
   * The seeder is idempotent by SKIP — an existing (organization_id, builtin_key)
   * row is left completely alone — so a workflow seeded disabled can never be
   * enabled by re-running it. Seeding an entry in its final state is therefore
   * the only honest option, and the no-double-send rule holds a different way:
   * an entry may only flip to `true` in the same change that DELETES the
   * hard-coded sender it replaces. Enabling one while its built-in still fires
   * double-emails every customer of every org.
   *
   * Enforced by a test (defaultAutomations.test.ts) that pins the cut-over set.
   */
  seed_enabled: boolean;
}

export const DEFAULT_AUTOMATIONS: DefaultAutomation[] = [
  {
    builtin_key: 'default-job-scheduled',
    name: 'Job scheduled confirmation',
    description:
      'Tells the customer their job has a date on the calendar. Replaces the built-in "Service Scheduled" email.',
    trigger_type: 'JOB_SCHEDULED',
    recipients: ['customer'],
    subject: 'Service Scheduled: {{job.number}}',
    // "Who's coming:" rather than "Technician:" — technician.names renders the
    // whole crew, so a singular label (or using the list as a sentence subject)
    // breaks the moment a job has more than one person on it.
    body: "Hi {{customer.first_name}}, your service {{job.number}} has been scheduled for {{job.scheduled_date}} at {{job.scheduled_time}}. Who's coming: {{technician.names}}. Address: {{job.address}}.",
    seed_enabled: true,
  },
  {
    builtin_key: 'default-job-rescheduled',
    name: 'Job rescheduled notice',
    description:
      'Tells the customer their job moved to a new time. Replaces the built-in "Job Rescheduled" email.',
    trigger_type: 'JOB_RESCHEDULED',
    recipients: ['customer'],
    subject: 'Job {{job.number}} Rescheduled',
    body: "Hi {{customer.first_name}}, your job {{job.number}} has been rescheduled to {{job.scheduled_date}} at {{job.scheduled_time}}. Who's coming: {{technician.names}}. Address: {{job.address}}.",
    seed_enabled: true,
  },
  {
    builtin_key: 'default-estimate-approved-notify-creator',
    name: 'Estimate approved — notify creator',
    description:
      "Tells the estimate's creator the customer approved it. Replaces the built-in creator-notification email.",
    trigger_type: 'ESTIMATE_APPROVED',
    recipients: ['creator'],
    subject: 'Estimate {{estimate.number}} — Approved',
    body: '{{customer.full_name}} approved estimate {{estimate.number}} ({{estimate.total}}).',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-estimate-declined-notify-creator',
    name: 'Estimate declined — notify creator',
    description:
      "Tells the estimate's creator the customer declined it. Replaces the built-in creator-notification email.",
    trigger_type: 'ESTIMATE_DECLINED',
    recipients: ['creator'],
    subject: 'Estimate {{estimate.number}} — Declined',
    body: '{{customer.full_name}} declined estimate {{estimate.number}} ({{estimate.total}}).',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-tech-assigned',
    name: 'Technician assigned',
    description:
      'Tells a technician they were added to a job. Replaces the built-in "New Job Assignment" email.',
    trigger_type: 'TECH_ASSIGNED',
    // assigned_user, not assigned_team: this dispatches once per newly-added
    // technician, and assigned_team would resolve to the whole live crew — see
    // the 2026-07-27 correction in the phase 3 cutover plan.
    recipients: ['assigned_user'],
    subject: 'New Job Assignment: {{job.number}}',
    body: 'Hi {{recipient.first_name}}, you have been assigned to job {{job.number}} for {{customer.full_name}} at {{job.address}}, scheduled for {{job.scheduled_date}} at {{job.scheduled_time}}. Scope: {{job.scope_notes}}',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-tech-unassigned',
    name: 'Technician unassigned',
    description:
      'Tells a technician they were removed from a job. Replaces the built-in "Removed from Job" email.',
    trigger_type: 'TECH_UNASSIGNED',
    recipients: ['removed_user'],
    subject: 'Removed from Job: {{job.number}}',
    body: 'Hi {{recipient.first_name}}, you have been removed from job {{job.number}} for {{customer.full_name}}. No further action is required.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-job-en-route',
    name: 'Technician en route',
    description:
      'Tells the customer the technician is on the way. Replaces the built-in "on the way" email.',
    trigger_type: 'JOB_EN_ROUTE',
    recipients: ['customer'],
    // Subject and body both stay count-neutral: the retired sender named one
    // technician, this names the whole crew, and neither line may assume a size.
    subject: "We're on the way",
    body: "Hi {{customer.first_name}}, we're on the way to {{job.address}} now. Who's coming: {{technician.names}}.",
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-scheduled',
    name: 'Walkthrough scheduled confirmation',
    description:
      'Tells the customer their site visit has a date. Replaces the built-in "Site Visit Scheduled" email.',
    trigger_type: 'WALKTHROUGH_SCHEDULED',
    recipients: ['customer'],
    subject: 'Site Visit Scheduled — {{lead.walkthrough_date}}',
    body: 'Hi {{customer.first_name}}, your site visit has been scheduled for {{lead.walkthrough_date}} at {{lead.walkthrough_time}}. {{lead.performer_names}} will visit {{lead.address}}.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-rescheduled',
    name: 'Walkthrough rescheduled notice',
    description:
      'Tells the customer their site visit moved. Replaces the built-in "Site Visit Rescheduled" email.',
    trigger_type: 'WALKTHROUGH_RESCHEDULED',
    recipients: ['customer'],
    subject: 'Site Visit Rescheduled — {{lead.walkthrough_date}}',
    body: 'Your site visit has been rescheduled to {{lead.walkthrough_date}} at {{lead.walkthrough_time}}. {{lead.performer_names}} will visit {{lead.address}}.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-performer-assigned',
    name: 'Walkthrough performer assigned',
    description:
      'Tells a performer they were added to a walkthrough. Replaces the built-in "Walkthrough Assigned" email.',
    trigger_type: 'WALKTHROUGH_PERFORMER_ASSIGNED',
    // assigned_user, not assigned_team — same reasoning as default-tech-assigned above.
    recipients: ['assigned_user'],
    subject: 'Walkthrough Assigned — {{customer.full_name}}',
    body: 'Hi {{recipient.first_name}}, you have been assigned a walkthrough for {{customer.full_name}} ({{lead.number}}) at {{lead.address}} on {{lead.walkthrough_date}} at {{lead.walkthrough_time}}.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-performer-removed',
    name: 'Walkthrough performer removed',
    description:
      'Tells a performer they were removed from a walkthrough. Replaces the built-in "Removed from Walkthrough" email.',
    trigger_type: 'WALKTHROUGH_PERFORMER_REMOVED',
    recipients: ['removed_user'],
    subject: 'Removed from Walkthrough — {{customer.full_name}}',
    body: 'Hi {{recipient.first_name}}, you have been removed from the walkthrough for {{customer.full_name}} ({{lead.number}}). No further action is required.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-completed',
    name: 'Walkthrough completed',
    description:
      'Follows up with the customer and notifies the lead owner after a site visit. Replaces the built-in "Site Visit Completed" emails.',
    trigger_type: 'WALKTHROUGH_COMPLETED',
    recipients: ['customer', 'salesperson'],
    subject: 'Site Visit Completed',
    body: "We've completed our site visit at {{lead.address}}. {{org.name}} will follow up with an estimate shortly.",
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-cancelled',
    name: 'Walkthrough cancelled',
    description:
      'Tells the customer, the performer, and the lead owner a scheduled site visit was cancelled, and why. Replaces the built-in "Site Visit Cancelled" emails.',
    trigger_type: 'WALKTHROUGH_CANCELLED',
    recipients: ['customer', 'assigned_team', 'salesperson'],
    subject: 'Site Visit Cancelled',
    body: 'Your scheduled site visit for {{customer.full_name}} ({{lead.number}}) has been cancelled. Reason: {{event.reason}}',
    seed_enabled: true,
  },
];

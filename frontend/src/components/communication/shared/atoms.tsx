/**
 * Communication atoms — shared visual primitives for the communication ↔ jobs
 * surfaces (job Communication tab, SMS/Inbox/WhatsApp centers, customer roll-up).
 * Promoted from the validated /prototype/comm Variant A (chosen 2026-06-10).
 *
 * Color contract (ServWave "Calm Intelligence"):
 * - Job pill = OCEAN (interactive/navigational anchor), never sage.
 * - "no job" = muted background.
 * - StateChip = SAGE, reserved for genuine business state (Approved / Paid).
 */
import { type LucideIcon, Mail, MessageCircle, MessageSquare, Phone } from 'lucide-react';

export type CommChannel = 'call' | 'email' | 'sms' | 'whatsapp';

/**
 * Job badge — "badge it, don't hide it". Ocean (interactive anchor), NOT sage:
 * a job tag is navigational, not a business/approved state.
 */
export function JobBadge({ job, className = '' }: { job?: string | null; className?: string }) {
  if (!job) {
    return (
      <span
        className={`inline-flex items-center rounded-pill border border-border bg-background-light px-2 py-0.5 text-[11px] font-semibold text-text-soft ${className}`}
      >
        no job
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-pill border border-primary/15 bg-primary-subtle px-2 py-0.5 text-[11px] font-semibold text-primary ${className}`}
    >
      {job}
    </span>
  );
}

/**
 * Lead badge — the lead-linkage sibling of JobBadge. Ocean-family informational
 * tone (lighter ocean-700 tint so it reads apart from the job pill), NEVER
 * sage: lead linkage is navigational, not a business/approved state. Renders
 * nothing when the row has no lead — the lead chip is additive (no "no lead"
 * counterpart to the muted no-job pill).
 */
export function LeadBadge({ lead, className = '' }: { lead?: string | null; className?: string }) {
  if (!lead) return null;
  return (
    <span
      className={`inline-flex items-center rounded-pill border border-ocean-700/20 bg-ocean-700/10 px-2 py-0.5 text-[11px] font-semibold text-ocean-700 ${className}`}
    >
      {lead}
    </span>
  );
}

const CH: Record<CommChannel, { Icon: LucideIcon; tint: string; label: string }> = {
  call: { Icon: Phone, tint: 'text-success-text', label: 'Call' },
  email: { Icon: Mail, tint: 'text-info', label: 'Email' },
  sms: { Icon: MessageSquare, tint: 'text-primary', label: 'Text' },
  whatsapp: { Icon: MessageCircle, tint: 'text-success-text', label: 'WhatsApp' },
};

export function ChannelIcon({ channel, className = '' }: { channel: CommChannel; className?: string }) {
  const { Icon, tint } = CH[channel];
  return <Icon className={`h-4 w-4 ${tint} ${className}`} />;
}

export function channelLabel(channel: CommChannel) {
  return CH[channel].label;
}

/** Business-state chip (sage) — the one legitimate sage use here: approved / paid. */
export function StateChip({ state }: { state?: string | null }) {
  if (!state) return null;
  return (
    <span className="inline-flex items-center rounded-pill border border-sage-200 bg-sage-50 px-2 py-0.5 text-[11px] font-semibold text-sage-700">
      {state}
    </span>
  );
}

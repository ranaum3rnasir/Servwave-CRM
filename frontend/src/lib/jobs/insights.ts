import { formatCurrency } from '@/lib/utils';

export interface JobInsight {
  key:
    | 'missing_photos'
    | 'estimate_approved'
    | 'crew_assigned'
    | 'documents_on_file'
    | 'photos_uploaded'
    | 'upsell_opportunity';
  title: string;
  detail?: string;
  severity: 'info' | 'warning';
}

interface InsightJob {
  status: string;
  job_type?: string | null;
  signature_at?: string | null;
  scheduled_start?: string | null;
  assignees?: Array<unknown> | null;
  estimate?: { estimate_number?: string; status?: string; total_amount?: number | string } | null;
}

interface InsightAttachment {
  context?: string | null;
  file_type?: string | null;
}

const PHOTO_STATUSES = new Set(['ON_SITE', 'IN_PROGRESS', 'COMPLETED']);

/**
 * Rule-based "AI Operations Insights" (BETA placeholder until the real model —
 * see #242). Everything here is derived from data already on the job, so the
 * card stays truthful: it only surfaces a recommendation when the underlying
 * signal exists. Warnings are ordered first.
 */
export function deriveJobInsights(
  job: InsightJob,
  attachments: InsightAttachment[] | null | undefined,
  _financials?: unknown,
): JobInsight[] {
  const atts = attachments ?? [];
  const photos = atts.filter((a) => (a.file_type ?? '').startsWith('image/'));
  const docs = atts.filter((a) => a.file_type != null && !a.file_type.startsWith('image/'));
  const hasAfterPhoto = atts.some((a) => a.context === 'AFTER_PHOTO');
  const crew = (job.assignees ?? []).length;
  const needsAfterPhoto = PHOTO_STATUSES.has(job.status) && !hasAfterPhoto;

  const insights: JobInsight[] = [];

  // ── Warnings ────────────────────────────────────────────────────────────
  if (needsAfterPhoto) {
    insights.push({
      key: 'missing_photos',
      title: 'Capture after/completion photos',
      detail: 'No after-photo is on file for this job.',
      severity: 'warning',
    });
  }
  // ── Informational recommendations ───────────────────────────────────────
  if (job.estimate && job.estimate.status === 'WON') {
    const total =
      job.estimate.total_amount != null ? formatCurrency(Number(job.estimate.total_amount)) : null;
    insights.push({
      key: 'estimate_approved',
      title: total ? `Approved estimate — ${total} contract value` : 'Estimate approved',
      detail: job.estimate.estimate_number
        ? `${job.estimate.estimate_number} signed off by the customer.`
        : undefined,
      severity: 'info',
    });
  }

  if (crew >= 2) {
    insights.push({
      key: 'crew_assigned',
      title: `Crew of ${crew} assigned`,
      detail: 'Coordinate arrival so the work wraps in a single visit.',
      severity: 'info',
    });
  }

  if (docs.length > 0) {
    insights.push({
      key: 'documents_on_file',
      title: `Documentation on file — ${docs.length} document${docs.length > 1 ? 's' : ''}`,
      detail: 'Scope and work-order docs are attached and ready for review.',
      severity: 'info',
    });
  }

  if (photos.length > 0 && !needsAfterPhoto) {
    insights.push({
      key: 'photos_uploaded',
      title: `${photos.length} job photo${photos.length > 1 ? 's' : ''} uploaded`,
      detail: 'Before/after documentation is building up nicely for this job.',
      severity: 'info',
    });
  }

  if (job.job_type) {
    insights.push({
      key: 'upsell_opportunity',
      title: 'Upsell opportunity',
      detail: `Offer a maintenance plan or extended hardware warranty — a common add-on for ${job.job_type.toLowerCase()}.`,
      severity: 'info',
    });
  }

  return insights;
}

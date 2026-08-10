import { logger } from './logger';
import { supabaseAdmin } from './supabase';

// Shared Supabase Storage bucket every generic entity Attachment (customer/lead/
// estimate/job/invoice) lives in. Extracted out of attachment.controller.ts
// (email slice 7) so a second storage consumer - the Communication module's
// email attachments - mints signed URLs from the exact same bucket/TTL instead
// of a driftable second copy of the same few lines.
export const ATTACHMENTS_BUCKET = 'attachments';

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour - short-lived per-read URLs

/**
 * Mint a fresh short-lived signed URL for a stored attachment. Falls back to
 * `legacyUrl` when there is no storage_path (pre-migration rows that only ever
 * had a public URL persisted).
 */
export async function buildAccessUrl(storagePath: string | null, legacyUrl: string): Promise<string> {
  if (!storagePath) return legacyUrl;
  const { data, error } = await supabaseAdmin.storage
    .from(ATTACHMENTS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    logger.warn(`Failed to mint signed URL for ${storagePath}, falling back to legacy URL`);
    return legacyUrl;
  }
  return data.signedUrl;
}

/**
 * Sanitize a client-supplied filename before it becomes part of a storage
 * path: strip path components, allow only [A-Za-z0-9._-], cap length.
 * Prevents path-traversal-looking bucket keys even though Supabase already
 * normalizes them.
 *
 * Shared (email slice 7) so attachment.controller.ts's generic uploader and
 * the Communication module's email-attachment uploader can never drift into
 * two hand-copied regex chains that quietly diverge.
 */
export function sanitizeAttachmentFilename(originalName: string): string {
  return (
    originalName
      .replace(/^.*[\\/]/, '')
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120) || 'file'
  );
}

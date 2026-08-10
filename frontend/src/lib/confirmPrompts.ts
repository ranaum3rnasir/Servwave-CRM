/**
 * Shared ConfirmDialog copy for actions that appear on more than one surface.
 *
 * Attachment delete exists on five surfaces (lead sections, the CRM/estimate/invoice panel, the
 * lightbox, and both job surfaces). They previously each spelled their own `window.confirm` string,
 * which is how the wording drifted - "Delete this attachment?" on some, `Delete "name"? This cannot
 * be undone.` on others. One helper means the prompt cannot diverge again.
 */
import type { ConfirmOptions } from '@/hooks/useConfirm';

/** `name` is optional because two call sites prompt from a context with no display name to hand. */
export function deleteAttachmentPrompt(name?: string | null): ConfirmOptions {
  return {
    title: name ? `Delete "${name}"?` : 'Delete this attachment?',
    description: 'This cannot be undone.',
    confirmLabel: 'Delete',
    tone: 'danger',
  };
}

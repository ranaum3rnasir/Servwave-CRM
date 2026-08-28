/**
 * The `accept` attribute for the generic attachment surfaces (customer, lead, estimate,
 * job, invoice).
 *
 * This MUST stay in step with `ALLOWED_MIME_TYPES` in
 * `backend/src/controllers/attachment.controller.ts`. The browser filter is a courtesy -
 * the server is the gate - but when the two drift the file picker greys out a file the
 * API would happily accept, and Windows reports the mismatch as "<file> does not exist",
 * which reads as data loss rather than a filter.
 *
 * Extensions are listed alongside the MIME types on purpose: Windows does not always
 * supply a type for .csv or legacy Office files, and a MIME-only filter hides them.
 */
export const ACCEPTED_UPLOAD_TYPES = [
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/csv', 'text/plain',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt',
].join(',');

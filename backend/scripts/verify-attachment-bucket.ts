/**
 * Fails when the `attachments` bucket's own rules are narrower than the app's (#1605).
 *
 * The .docx outage came from exactly this drift: `ALLOWED_MIME_TYPES`, the magic-byte sniffer
 * and the browser `accept` filter were all widened to Office/CSV/TXT, while the bucket's
 * `allowed_mime_types` still held the original seven. Every app-side gate passed and Supabase
 * rejected the object, which surfaced as an unexplained "Failed to upload file".
 *
 * Nothing in code can see that config, so this check has to talk to the project. Run it against
 * staging and prod after any change to the allow-list or the size caps:
 *
 *   npm run verify:attachment-bucket --workspace=backend
 */
import { supabaseAdmin } from '../src/lib/supabase';
import { ALLOWED_MIME_TYPES, MAX_VIDEO_FILE_SIZE } from '../src/controllers/attachment.controller';
import { ATTACHMENTS_BUCKET } from '../src/lib/attachment-access';

async function main(): Promise<void> {
  const { data: bucket, error } = await supabaseAdmin.storage.getBucket(ATTACHMENTS_BUCKET);
  if (error || !bucket) {
    console.error(`Could not read the ${ATTACHMENTS_BUCKET} bucket: ${error?.message ?? 'not found'}`);
    process.exit(1);
  }

  const problems: string[] = [];
  const warnings: string[] = [];

  // A null allow-list means "anything", which is permissive enough to never cause this failure.
  const allowed = bucket.allowed_mime_types;
  if (allowed) {
    const missing = ALLOWED_MIME_TYPES.filter((t) => !allowed.includes(t));
    if (missing.length) {
      problems.push(
        `the bucket rejects ${missing.length} type(s) the API accepts:\n    ${missing.join('\n    ')}`,
      );
    }
  }

  // Equal is not enough: the app's own cap has to be reachable, so the bucket ceiling must sit
  // strictly above it or a file at exactly the app limit lands on the bucket's boundary.
  const limit = bucket.file_size_limit;
  if (limit != null && limit <= MAX_VIDEO_FILE_SIZE) {
    warnings.push(
      `the bucket's file_size_limit (${limit} bytes) does not exceed the API's largest accepted ` +
      `file (${MAX_VIDEO_FILE_SIZE} bytes)`,
    );
  }

  for (const w of warnings) console.warn(`WARN - ${w}`);

  if (problems.length) {
    console.error(`FAIL - ${ATTACHMENTS_BUCKET} bucket is narrower than the API:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`OK - ${ATTACHMENTS_BUCKET} accepts every type the API does (${ALLOWED_MIME_TYPES.length} types).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

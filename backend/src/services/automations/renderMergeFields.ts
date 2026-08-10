/**
 * renderMergeFields — pure {{merge.field}} interpolation for automation copy.
 *
 * Rules (pinned by tests):
 * - Known field → its value ('' when empty). Values are user-controlled data
 *   (names, addresses), so html mode escapes every substitution via esc().
 * - Unknown field → left literal, so a typo'd {{customer.frist_name}} is
 *   visible in previews and sent messages instead of silently vanishing.
 */

import { esc } from '../../lib/email';

const FIELD_RE = /\{\{([a-z_.]+)\}\}/g;

export function renderMergeFields(
  text: string,
  ctx: Record<string, string | undefined>,
  opts: { html: boolean },
): string {
  return text.replace(FIELD_RE, (raw, field: string) => {
    // hasOwnProperty (not `in`) so inherited prototype keys like {{constructor}}
    // and {{__proto__}} stay literal instead of resolving to functions/objects.
    if (!Object.prototype.hasOwnProperty.call(ctx, field)) return raw;
    const value = ctx[field] ?? '';
    return opts.html ? esc(value) : value;
  });
}

import { prisma } from './prisma';

/**
 * Default organization timezone. ALPHA's first customers operate in the US
 * Eastern timezone. Per-org overrides live on Organization.timezone.
 */
export const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * Format a Date as a human-readable date + time string in an explicit IANA
 * timezone (e.g. "June 8, 2026 at 11:00 AM").
 *
 * Server-side renderers (emails, PDFs, SMS) MUST pass the org timezone, because
 * the backend process runs in UTC: `toLocaleString` without a `timeZone` emits
 * the server's UTC wall-clock, which is 4–5 hours ahead of Eastern and does not
 * match what users see in the browser-rendered CRM.
 */
export function formatDateTimeInZone(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

/**
 * Resolve an organization's configured timezone, falling back to the default
 * if the org is missing, has no timezone set, or the lookup fails. Safe to call
 * in fire-and-forget email paths — never throws.
 */
export async function getOrgTimezone(organizationId: string): Promise<string> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Default currency. ALPHA's first customers bill in USD; per-org override on Organization.currency. */
export const DEFAULT_CURRENCY = 'USD';

/**
 * Resolve an organization's configured ISO-4217 currency code, falling back to
 * USD if the org is missing, has no currency set, or the lookup fails. Safe to
 * call in fire-and-forget email / PDF paths — never throws. (#126)
 */
export async function getOrgCurrency(organizationId: string): Promise<string> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { currency: true },
    });
    return org?.currency || DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

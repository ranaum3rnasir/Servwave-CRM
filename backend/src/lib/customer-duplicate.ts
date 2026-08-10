import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Duplicate-customer guard (spec: md_files/plans/customers/2026-06-08-duplicate-customer-guard.md).
 *
 * Detects an existing customer in the same organization whose primary email OR
 * primary phone matches a new customer's contact info. Since #352 phones are
 * stored digits-only canonical (Zod-normalized at the validation boundary +
 * one-time backfill), but the comparison still normalizes BOTH the input and
 * the stored value in JS — cheap, and it keeps the guard correct for any
 * non-canonical stragglers (e.g. carved-out placeholder sentinels) and for
 * mixed-case emails (`A@x.com` vs `a@x.com`).
 */

// Accept either the Prisma client or a transaction client — callable inside the
// existing $transaction in lead.controller.ts as well as standalone.
type Client = PrismaClient | Prisma.TransactionClient;

export interface ExistingMatch {
  id: string;
  customer_number: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  archived_at: Date | null;
  primary_address: { line1: string; city: string; state: string } | null;
  /**
   * The exact value(s) that collided. Because the guard is relation-aware, the
   * match may be on a SECONDARY phones[]/extra_emails[] entry — not the primary
   * email/phone above — so the dialog must show/highlight `matched.*` (the value
   * the user actually typed), not the primary. `null` when that field didn't match.
   */
  matched: { email: string | null; phone: string | null };
}

/** Trim + lowercase. Returns null for null/undefined/blank. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v.length ? v : null;
}

/**
 * Digits-only. Strips spaces, dashes, parens, `+`, etc., and a single leading
 * country `1` from an 11-digit result. Returns null for null/undefined/blank.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length ? digits : null;
}

// Select shape for the duplicate-warning modal (spec §4.4).
const MATCH_SELECT = {
  id: true,
  customer_number: true,
  first_name: true,
  last_name: true,
  company_name: true,
  email: true,
  phone: true,
  is_active: true,
  archived_at: true,
  service_locations: {
    where: { is_primary: true },
    take: 1,
    select: { address_line1: true, city: true, state: true },
  },
  phones: { select: { phone: true } },
  extra_emails: { select: { email: true } },
} satisfies Prisma.CustomerSelect;

type Candidate = {
  id: string;
  customer_number: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  archived_at: Date | null;
  service_locations: { address_line1: string; city: string; state: string }[];
  phones: { phone: string }[];
  extra_emails: { email: string }[];
};

/**
 * Returns the first existing customer in `orgId` whose normalized primary email
 * or phone equals the (normalized) input, or null when there is no match.
 *
 * Strategy (hybrid): a loose, org-scoped DB pre-filter narrows the candidate
 * set (recall-only — must not drop true matches), then a JS pass normalizes
 * both sides and decides the match. The JS pass is the source of truth.
 */
export async function findDuplicateCustomer(
  client: Client,
  orgId: string,
  input: { email?: string | null; phone?: string | null },
  /**
   * When set, this customer is excluded from the candidate set. Used by the
   * cross-customer accretion guard: while a customer is already linked, its OWN
   * prefilled primary/secondary contact must not count as a "duplicate" — only a
   * DIFFERENT customer's contact should. (accreteContactMethods dedups the
   * same-customer case separately.)
   */
  excludeCustomerId?: string,
): Promise<ExistingMatch | null> {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  if (!email && !phone) return null;

  // DB pre-filter is recall-only — it must not drop a true match, since the JS
  // pass below is the source of truth. Phone is stored formatted/un-normalized,
  // so it cannot be matched in SQL; when a phone is supplied we fall back to the
  // full org-scoped candidate set and let the JS pass decide. When only an email
  // is supplied we can safely narrow with a case-insensitive equality.
  const baseWhere: Prisma.CustomerWhereInput = phone
    ? { organization_id: orgId }
    : {
        organization_id: orgId,
        OR: [
          { email: { equals: email as string, mode: 'insensitive' } },
          { extra_emails: { some: { email: { equals: email as string, mode: 'insensitive' } } } },
        ],
      };
  const where: Prisma.CustomerWhereInput = excludeCustomerId
    ? { ...baseWhere, id: { not: excludeCustomerId } }
    : baseWhere;

  const candidates = (await client.customer.findMany({
    where,
    select: MATCH_SELECT,
  })) as Candidate[];

  for (const c of candidates) {
    // Capture the exact value that matched (primary first, else the secondary
    // relation entry) so the dialog can show the value the user actually typed.
    const emailMatch = email
      ? (normalizeEmail(c.email) === email
          ? c.email
          : c.extra_emails.find((e) => normalizeEmail(e.email) === email)?.email ?? null)
      : null;
    const phoneMatch = phone
      ? (normalizePhone(c.phone) === phone
          ? c.phone
          : c.phones.find((p) => normalizePhone(p.phone) === phone)?.phone ?? null)
      : null;
    if (emailMatch || phoneMatch) {
      const loc = c.service_locations[0];
      return {
        id: c.id,
        customer_number: c.customer_number,
        first_name: c.first_name,
        last_name: c.last_name,
        company_name: c.company_name,
        email: c.email,
        phone: c.phone,
        is_active: c.is_active,
        archived_at: c.archived_at,
        primary_address: loc
          ? { line1: loc.address_line1, city: loc.city, state: loc.state }
          : null,
        matched: { email: emailMatch, phone: phoneMatch },
      };
    }
  }

  return null;
}

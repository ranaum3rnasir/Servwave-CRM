/**
 * Estimate-container backfill — core classification/write logic (editable record
 * IDs foundation, SERV10X-61 follow-up). No CLI here; see
 * scripts/estimate-container-backfill.ts for the invokable wrapper.
 *
 * A container-style estimate number is minted as "<parentNumber>-<seq>"
 * (`L00005-1`, `698159-3`, `9384-2`) where the parent is whichever of
 * Lead.lead_number / Customer.customer_number / Job.job_number matches the text
 * before the LAST hyphen. Estimate.container_kind/container_seq record that
 * link going forward (see prisma/schema.prisma EstimateContainerKind), but rows
 * created before those columns existed never had them populated — this backfill
 * recovers them for existing rows by re-deriving the parent from the number
 * string and matching it against the org's own leads/customers/jobs.
 *
 * A "flat" estimate number (legacy "E00001" series, or a bare Workiz-imported
 * number like "698470") has no trailing "-<digits>" suffix at all and is NOT
 * container-style — parseContainerNumber returns null for it and it is left
 * alone entirely (container_kind/container_seq stay null, never touched).
 *
 * ALL DB work must run inside runWithOrg(orgId): with DB_TENANT_GUARD=on a
 * standalone script has no request context, so every query would otherwise
 * fail CLOSED (zero rows) — same contract as scripts/ctm-backfill.ts.
 *
 * Ambiguity guard: a base number can theoretically match more than one parent
 * across Lead/Customer/Job within the same org (e.g. a lead numbered "12345"
 * AND a job numbered "12345" both existing). This is an all-or-nothing gate
 * per org — runEstimateContainerBackfillForOrg refuses to write ANYTHING
 * (resolved rows included) the moment even one ambiguous row is found, and
 * throws with every ambiguous row's id/number/candidates so it's diagnosable.
 * A stale "0 ambiguous" fact from an earlier audit is not a system guarantee;
 * this re-asserts it at run time, every run.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from './prisma';
import { runWithOrg } from './tenant-context';

export interface ParsedContainerNumber {
  base: string;
  seq: number;
}

/**
 * Parses a trailing "-<digits>" suffix off an estimate number. Returns null
 * when there is none (a flat/legacy number — not container-style). Matches on
 * the LAST hyphen only — a base itself may legally contain hyphens (org
 * prefixes can: PREFIX_REGEX = /^[A-Za-z0-9-]{1,10}$/ in organization.controller.ts).
 *
 * "L00005-1" -> { base: 'L00005', seq: 1 }
 * "698159-3" -> { base: '698159', seq: 3 }
 * "E00001"   -> null
 * "698470"   -> null
 * "LO-42-7"  -> { base: 'LO-42', seq: 7 }
 */
export function parseContainerNumber(estimateNumber: string): ParsedContainerNumber | null {
  const lastHyphen = estimateNumber.lastIndexOf('-');
  if (lastHyphen === -1) return null;

  const base = estimateNumber.slice(0, lastHyphen);
  const seqPart = estimateNumber.slice(lastHyphen + 1);
  if (!base || !/^\d+$/.test(seqPart)) return null;

  return { base, seq: parseInt(seqPart, 10) };
}

export type ContainerKind = 'LEAD' | 'CUSTOMER' | 'JOB';

export interface ResolvedEstimate {
  id: string;
  base: string;
  seq: number;
  kind: ContainerKind;
}

export interface UnmatchedEstimate {
  id: string;
  estimateNumber: string;
}

export interface AmbiguousEstimate {
  id: string;
  estimateNumber: string;
  candidates: Array<{ kind: ContainerKind; id: string }>;
}

export interface ClassificationResult {
  resolved: ResolvedEstimate[];
  unmatched: UnmatchedEstimate[];
  ambiguous: AmbiguousEstimate[];
}

export interface ParentsByNumber {
  LEAD: Map<string, string>;
  CUSTOMER: Map<string, string>;
  JOB: Map<string, string>;
}

const KIND_ORDER: ContainerKind[] = ['LEAD', 'CUSTOMER', 'JOB'];

/**
 * Pure function, no I/O: given ALL of an org's container-style estimates (id +
 * estimate_number, already pre-filtered to rows where parseContainerNumber(...)
 * is non-null) and lookup maps of { [number]: id } for that org's
 * leads/customers/jobs, classify each estimate as resolved (exactly one
 * candidate matched its parsed base across all three maps combined), unmatched
 * (zero candidates), or ambiguous (2+ candidates).
 */
export function classifyContainerEstimates(
  estimates: Array<{ id: string; estimate_number: string }>,
  parentsByNumber: ParentsByNumber,
): ClassificationResult {
  const resolved: ResolvedEstimate[] = [];
  const unmatched: UnmatchedEstimate[] = [];
  const ambiguous: AmbiguousEstimate[] = [];

  for (const estimate of estimates) {
    const parsed = parseContainerNumber(estimate.estimate_number);
    if (!parsed) continue; // not container-style — never reaches here per the caller's contract, but stay defensive

    const candidates: Array<{ kind: ContainerKind; id: string }> = [];
    for (const kind of KIND_ORDER) {
      const id = parentsByNumber[kind].get(parsed.base);
      if (id) candidates.push({ kind, id });
    }

    if (candidates.length === 0) {
      unmatched.push({ id: estimate.id, estimateNumber: estimate.estimate_number });
    } else if (candidates.length === 1) {
      resolved.push({ id: estimate.id, base: parsed.base, seq: parsed.seq, kind: candidates[0].kind });
    } else {
      ambiguous.push({ id: estimate.id, estimateNumber: estimate.estimate_number, candidates });
    }
  }

  return { resolved, unmatched, ambiguous };
}

export interface BackfillCounters {
  scanned: number;
  resolved: number;
  unmatched: number;
  ambiguous: number;
}

export interface BackfillDeps {
  prisma: PrismaClient;
}

export function defaultDeps(): BackfillDeps {
  return { prisma: defaultPrisma as unknown as PrismaClient };
}

export interface BackfillOpts {
  orgId: string;
  dryRun?: boolean;
}

export interface BackfillRunResult {
  counters: BackfillCounters;
  unmatched: UnmatchedEstimate[];
  ambiguous: AmbiguousEstimate[];
}

function formatAmbiguousMessage(orgId: string, ambiguous: AmbiguousEstimate[]): string {
  const lines = ambiguous.map((a) => {
    const candidateList = a.candidates.map((c) => `${c.kind}:${c.id}`).join(', ');
    return `  - estimate ${a.id} (${a.estimateNumber}) matched multiple parents: ${candidateList}`;
  });
  return (
    `Refusing to backfill org ${orgId}: ${ambiguous.length} estimate(s) have an ambiguous ` +
    `container parent (2+ candidates across Lead/Customer/Job) — nothing was written for this ` +
    `org. Resolve the collision manually, then re-run:\n${lines.join('\n')}`
  );
}

/**
 * Orchestrates one org: runs inside runWithOrg(orgId). Loads ALL of the org's
 * estimates, filters to container-style via parseContainerNumber, loads
 * lead/customer/job number maps for the org, classifies, and (unless dryRun)
 * writes container_kind/container_seq for every resolved row.
 *
 * All-or-nothing per org: if ANY estimate is ambiguous, this throws before
 * writing anything (resolved rows included). unmatched rows are reported, never
 * silently dropped from the counters, and are left untouched either way
 * (container_kind stays null).
 */
export async function runEstimateContainerBackfillForOrg(
  deps: BackfillDeps,
  opts: BackfillOpts,
): Promise<BackfillRunResult> {
  return runWithOrg(opts.orgId, async () => {
    const allEstimates = await deps.prisma.estimate.findMany({
      where: { organization_id: opts.orgId },
      select: { id: true, estimate_number: true },
    });

    const containerStyle = allEstimates.filter((e) => parseContainerNumber(e.estimate_number) !== null);

    const [leads, customers, jobs] = await Promise.all([
      deps.prisma.lead.findMany({
        where: { organization_id: opts.orgId },
        select: { id: true, lead_number: true },
      }),
      deps.prisma.customer.findMany({
        where: { organization_id: opts.orgId },
        select: { id: true, customer_number: true },
      }),
      deps.prisma.job.findMany({
        where: { organization_id: opts.orgId },
        select: { id: true, job_number: true },
      }),
    ]);

    const parentsByNumber: ParentsByNumber = {
      LEAD: new Map(leads.map((l: { id: string; lead_number: string }) => [l.lead_number, l.id])),
      CUSTOMER: new Map(customers.map((c: { id: string; customer_number: string }) => [c.customer_number, c.id])),
      JOB: new Map(jobs.map((j: { id: string; job_number: string }) => [j.job_number, j.id])),
    };

    const { resolved, unmatched, ambiguous } = classifyContainerEstimates(containerStyle, parentsByNumber);

    const counters: BackfillCounters = {
      scanned: containerStyle.length,
      resolved: resolved.length,
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
    };

    if (ambiguous.length > 0) {
      throw new Error(formatAmbiguousMessage(opts.orgId, ambiguous));
    }

    if (!opts.dryRun) {
      for (const row of resolved) {
        await deps.prisma.estimate.update({
          where: { id: row.id },
          data: { container_kind: row.kind, container_seq: row.seq },
        });
      }
    }

    return { counters, unmatched, ambiguous };
  });
}

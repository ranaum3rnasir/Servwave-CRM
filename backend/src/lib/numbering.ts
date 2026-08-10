import { Prisma, PrismaClient } from '@prisma/client';

type Entity =
  | 'lead'
  | 'estimate'
  | 'job'
  | 'invoice'
  | 'customer'
  | 'service_plan'
  | 'task'
  | 'purchase_order'
  | 'logistic_order';

type EntityFields = {
  next: string;
  prefix: string;
  firstIssued: string;
  table: string;
  numberCol: string;
  /**
   * Extra SQL predicate ANDed into the self-heal subquery, aliased `t`.
   *
   * Only entities whose number column holds MORE than the flat sequence need this.
   * Today that is `logistic_order`: anchored numbers (`LO-J00042-7`) share the
   * `number` column with flat ones (`LO00003`), and their trailing digits are a
   * per-anchor seq, not a document sequence — without the filter the self-heal MAX
   * reads `7` and jumps the flat counter to `LO00008` (gaps, never collisions).
   *
   * The discriminator is `t.seq IS NULL`, which is the SCHEMA's own definition of
   * "flat" (seq is NULL for standalone numbers, NOT NULL for anchored ones). It is
   * unenforced by design — no CHECK ties `seq` to the anchor FKs, because a flat LO
   * that is re-linked later keeps its flat number AND its NULL seq, which is exactly
   * where this filter wants it. See the "DELIBERATELY NO CHECK" note in
   * 20260720120000_logistic_orders_foundations. It deliberately is NOT the
   * string heuristic `t.number NOT LIKE '%-%'`: hyphens are legal in org prefixes
   * (PREFIX_REGEX = /^[A-Za-z0-9-]{1,10}$/, organization.controller.ts), so an org
   * with `logistic_order_prefix = 'LO-'` renders every FLAT number as `LO-00001`,
   * which that heuristic would exclude — silently turning the self-heal into a no-op
   * and re-opening the exact counter drift it exists to prevent.
   *
   * Like every other identifier here, this is a literal in this closed constant and
   * is spliced with `Prisma.raw` — never caller input.
   */
  selfHealFilter?: string;
};

const FIELDS: Record<Entity, EntityFields> = {
  lead:           { next: 'lead_next_number',           prefix: 'lead_prefix',           firstIssued: 'lead_first_issued_at',           table: 'leads',           numberCol: 'lead_number' },
  estimate:       { next: 'estimate_next_number',       prefix: 'estimate_prefix',       firstIssued: 'estimate_first_issued_at',       table: 'estimates',       numberCol: 'estimate_number' },
  job:            { next: 'job_next_number',            prefix: 'job_prefix',            firstIssued: 'job_first_issued_at',            table: 'jobs',            numberCol: 'job_number' },
  invoice:        { next: 'invoice_next_number',        prefix: 'invoice_prefix',        firstIssued: 'invoice_first_issued_at',        table: 'invoices',        numberCol: 'invoice_number' },
  customer:       { next: 'customer_next_number',       prefix: 'customer_prefix',       firstIssued: 'customer_first_issued_at',       table: 'customers',       numberCol: 'customer_number' },
  service_plan:   { next: 'service_plan_next_number',   prefix: 'service_plan_prefix',   firstIssued: 'service_plan_first_issued_at',   table: 'service_plans',   numberCol: 'service_plan_number' },
  task:           { next: 'task_next_number',           prefix: 'task_prefix',           firstIssued: 'task_first_issued_at',           table: 'tasks',           numberCol: 'task_number' },
  purchase_order: { next: 'purchase_order_next_number', prefix: 'purchase_order_prefix', firstIssued: 'purchase_order_first_issued_at', table: 'purchase_orders', numberCol: 'po_number' },
  logistic_order: { next: 'logistic_order_next_number', prefix: 'logistic_order_prefix', firstIssued: 'logistic_order_first_issued_at', table: 'logistic_orders', numberCol: 'number', selfHealFilter: 't.seq IS NULL' },
};

/**
 * Atomically allocate the next number for `entity` in `orgId`.
 *
 * Single UPDATE ... RETURNING: increments counter + COALESCE-sets first_issued_at.
 * Postgres holds an exclusive row-level lock on the org row until commit, so
 * concurrent allocations against the same org serialize and each sees its own
 * incremented value via RETURNING.
 *
 * `Prisma.raw()` is ONLY called with table/column names from the closed FIELDS constant
 * (type-safe `entity: 'lead' | 'estimate' | 'job' | 'invoice' | 'customer' | 'service_plan'`).
 * `orgId` is parameterized, never interpolated.
 *
 * Self-healing: the counter is advanced to GREATEST(stored, max-existing-number + 1) before
 * being consumed, so a counter that has drifted *behind* reality (e.g. rows inserted on the
 * shared staging DB by another branch without bumping it) can never hand back an already-used
 * number → no more unique-violation 500s on create. On a consistent DB the GREATEST picks the
 * stored value, so behaviour is unchanged (the max-suffix subquery is a small per-org scan;
 * fine at current scale — revisit if an entity table grows very large).
 *
 * Returns the formatted number string, e.g. "L00001" or "BG-0042".
 */
export async function allocateNumber(
  tx: Prisma.TransactionClient | PrismaClient,
  entity: Entity,
  orgId: string,
): Promise<string> {
  const f = FIELDS[entity];
  // Literal from the closed FIELDS constant, never caller input (see EntityFields.selfHealFilter).
  const selfHealFilter = f.selfHealFilter ? Prisma.raw(`AND (${f.selfHealFilter})`) : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ next_value: number; prefix: string; padding: number }>>`
    UPDATE organizations
    SET ${Prisma.raw(f.next)} = GREATEST(
          ${Prisma.raw(f.next)},
          COALESCE((
            SELECT MAX((substring(t.${Prisma.raw(f.numberCol)} FROM '[0-9]+$'))::int)
            FROM ${Prisma.raw(f.table)} t
            WHERE t.organization_id = organizations.id ${selfHealFilter}
          ), 0) + 1
        ) + 1,
        ${Prisma.raw(f.firstIssued)} = COALESCE(${Prisma.raw(f.firstIssued)}, NOW())
    WHERE id = ${orgId}::uuid
    RETURNING ${Prisma.raw(f.next)} AS next_value,
              ${Prisma.raw(f.prefix)} AS prefix,
              number_padding AS padding
  `;
  if (rows.length === 0) {
    throw new Error(`Organization ${orgId} not found when allocating ${entity} number`);
  }
  const { next_value, prefix, padding } = rows[0];
  // next_value is post-increment; the allocated number is next_value - 1.
  const allocated = Number(next_value) - 1;
  return `${prefix}${String(allocated).padStart(Number(padding), '0')}`;
}

// ============================================================================
// Container numbering - `L00005-1` / `C00010-1` / `J00007-1`  (SERV10X-61)
// ============================================================================

/**
 * The three anchor containers a NEW estimate can be numbered within, plus the human-number
 * column read off the LOCKED container row. All literals in a closed constant - spliced with
 * `Prisma.raw`, never caller input (identical safety posture to `ANCHORS` above).
 */
const ESTIMATE_CONTAINERS = {
  lead:     { table: 'leads',     numberColumn: 'lead_number' },
  customer: { table: 'customers', numberColumn: 'customer_number' },
  job:      { table: 'jobs',      numberColumn: 'job_number' },
} as const satisfies Record<string, { table: string; numberColumn: string }>;

export type EstimateContainer = keyof typeof ESTIMATE_CONTAINERS;

/**
 * Allocate a per-container estimate number - `L00005-1`, `C00010-1`, `J00007-1` (spec §5.7).
 *
 * SERV10X-61 numbers each NEW estimate within its anchor container (lead / customer / job)
 * instead of the flat org-wide `E00001` series. Single `UPDATE <container> SET estimate_seq =
 * estimate_seq + 1 … RETURNING estimate_seq, <number_col>`: a plain UPDATE takes an implicit
 * `FOR NO KEY UPDATE` row lock on the container row held until commit, so concurrent allocations
 * against the SAME container serialize and each RETURNING sees its own incremented value - the
 * same discipline `allocateNumber` applies to the organizations row. The `organization_id`
 * predicate keeps it tenant-scoped even though `id` is globally unique.
 *
 * MUST be called with the transaction client as part of the create transaction, so a failed
 * estimate insert releases the lock and rolls the counter increment back with it.
 *
 * No self-heal (unlike `allocateNumber`): `estimate_seq` is the sole source of truth for
 * container numbering - every legacy estimate uses the flat `E…` series, which can never collide
 * with `<container_number>-<seq>`, so there is no pre-existing container-scoped number for the
 * counter to have drifted behind. `@@unique([organization_id, estimate_number])` is the backstop.
 */
export async function allocateContainerEstimateNumber(
  tx: Prisma.TransactionClient | PrismaClient,
  container: EstimateContainer,
  containerId: string,
  orgId: string,
): Promise<string> {
  const c = ESTIMATE_CONTAINERS[container];
  const rows = await tx.$queryRaw<Array<{ seq: number; container_number: string }>>`
    UPDATE ${Prisma.raw(c.table)}
    SET estimate_seq = estimate_seq + 1
    WHERE id = ${containerId}::uuid AND organization_id = ${orgId}::uuid
    RETURNING estimate_seq AS seq, ${Prisma.raw(c.numberColumn)} AS container_number
  `;
  if (rows.length === 0) {
    throw new Error(
      `Container ${container}/${containerId} not found in organization ${orgId} when allocating estimate number`,
    );
  }
  return `${rows[0].container_number}-${Number(rows[0].seq)}`;
}

// ============================================================================
// Anchored numbering — `LO-J00042-1`
// ============================================================================

/**
 * Anchor kinds in numbering-precedence order: most specific wins.
 *
 * A document may link to several anchors at once; only the FIRST one present here
 * shapes its number, the rest stay plain links (spec §11 build note a). The number
 * is minted once at creation and is immutable — re-linking never renumbers.
 */
export const ANCHOR_PRECEDENCE = ['job', 'invoice', 'estimate', 'lead', 'customer', 'service_plan'] as const;

export type AnchorKind = (typeof ANCHOR_PRECEDENCE)[number];

/**
 * The closed allowlist. Every identifier interpolated into anchored-numbering SQL
 * comes from here — `Prisma.raw` is never handed a caller-supplied string.
 *
 * `numberColumn` is the anchor's own human-number column, read off the LOCKED row so
 * the minted string can never disagree with the row the lock and the sequence domain
 * key off (all six verified against schema.prisma).
 */
export const ANCHORS = {
  job:          { table: 'jobs',          column: 'job_id',          numberColumn: 'job_number' },
  invoice:      { table: 'invoices',      column: 'invoice_id',      numberColumn: 'invoice_number' },
  estimate:     { table: 'estimates',     column: 'estimate_id',     numberColumn: 'estimate_number' },
  lead:         { table: 'leads',         column: 'lead_id',         numberColumn: 'lead_number' },
  customer:     { table: 'customers',     column: 'customer_id',     numberColumn: 'customer_number' },
  service_plan: { table: 'service_plans', column: 'service_plan_id', numberColumn: 'service_plan_number' },
} as const satisfies Record<AnchorKind, { table: string; column: string; numberColumn: string }>;

export type AnchorTable = (typeof ANCHORS)[AnchorKind]['table'];
export type AnchorColumn = (typeof ANCHORS)[AnchorKind]['column'];

/**
 * Tables that carry an anchored `number` + int `seq` pair. Generic on purpose: the
 * estimate-renumbering effort adds `'estimates'` here and passes `documentPrefix: 'E'`
 * rather than re-implementing the allocator (spec §11 build note c).
 */
const DOCUMENT_TABLES = ['logistic_orders'] as const;
export type DocumentTable = (typeof DOCUMENT_TABLES)[number];

const ANCHOR_TABLES = new Set<string>(ANCHOR_PRECEDENCE.map((k) => ANCHORS[k].table));
const ANCHOR_COLUMNS = new Set<string>(ANCHOR_PRECEDENCE.map((k) => ANCHORS[k].column));
const ANCHOR_BY_TABLE = new Map<string, (typeof ANCHORS)[AnchorKind]>(
  ANCHOR_PRECEDENCE.map((k) => [ANCHORS[k].table, ANCHORS[k]]),
);

/**
 * Escape a value for use inside a bound SQL `LIKE` pattern. Postgres' default LIKE
 * escape character is backslash, so the wildcards and the escape char itself must be
 * neutralised before they are concatenated into the pattern.
 */
function escapeLikeLiteral(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function assertAllowlisted(kind: string, value: string, allowed: Set<string>): void {
  if (!allowed.has(value)) {
    throw new Error(`Refusing to build anchored-numbering SQL: ${kind} "${value}" is not in the allowlist`);
  }
}

export interface AnchoredNumberInput {
  organizationId: string;
  /** Anchor's table, e.g. `'jobs'` — allowlisted against ANCHORS. */
  anchorTable: AnchorTable;
  /** Document's FK column pointing at the anchor, e.g. `'job_id'` — allowlisted against ANCHORS. */
  anchorColumn: AnchorColumn;
  anchorId: string;
  /**
   * OPTIONAL assertion, not an input: the number is always taken from the locked
   * anchor row. When supplied it is verified against that row and a mismatch throws,
   * so a stale cache or a wrong lookup fails loudly instead of minting a number from
   * one row while holding the lock on another.
   */
  anchorNumber?: string;
  /** Document prefix; `'LO'` for logistic orders, `'E'` for a future anchored estimate scheme. */
  documentPrefix?: string;
  /** Table holding the `seq` column to read; allowlisted against DOCUMENT_TABLES. */
  documentTable?: DocumentTable;
}

/**
 * Allocate the next per-anchor sequence for a document anchored to `anchorId`,
 * returning `{ number: 'LO-J00042-1', seq: 1 }`.
 *
 * Concurrency: `SELECT … FOR NO KEY UPDATE` on the ANCHOR row takes a row-level lock
 * held until commit, so concurrent allocations against the same anchor serialize — the
 * same trick `allocateNumber` plays with the organizations row, just with a narrower
 * lock target. There is deliberately NO retry loop: `@@unique([organization_id,
 * number])` on the document table is the backstop, and a P2002 there means a bug, not a
 * race we should paper over.
 *
 * Why NO KEY, specifically: `FOR UPDATE` conflicts with `FOR KEY SHARE`, which Postgres
 * takes on a referenced row for ANY insert of a row carrying an FK to it. `jobs` is the
 * hottest row in the system and `job` is the default anchor, so plain `FOR UPDATE` here
 * would block every concurrent job_line_item / task / attachment / note / invoice /
 * stock_movement insert against that job — plus any `UPDATE jobs SET status` — for the
 * whole create transaction. `FOR NO KEY UPDATE` still conflicts with ITSELF, so the
 * allocators serialize exactly as intended, but it does not conflict with `FOR KEY
 * SHARE`. (The flat allocator gets this right implicitly: a plain UPDATE takes
 * `FOR NO KEY UPDATE`.)
 *
 * MUST be called with the transaction client and as the first statement of the create
 * transaction, exactly like `allocateNumber` — a failed insert must release the lock and
 * roll the allocation back with it.
 *
 * `seq` is returned as an int and MUST be persisted to the int `seq` column: string sort
 * puts `-10` before `-2`, so ordering can only be done on the number (spec §11 note b).
 * The read self-heals past a NULL `seq` by falling back to the trailing digit-run of
 * `number`, mirroring the flat allocator's GREATEST: without it a single NULL-seq row
 * would make `COALESCE(MAX(seq),0)+1` re-mint an already-used number forever, and the
 * unique index would make that anchor permanently un-creatable.
 *
 * Sequence domain: scoped to the rows this anchor actually SHAPED (`number LIKE
 * '<prefix>-<anchorNumber>-%'`), not merely the rows that link to it. A document may
 * carry several anchors at once — only the precedence winner shapes the number, "the
 * rest stay plain links" — so scoping by the FK column alone lets a job-anchored LO
 * advance its customer's series, and the customer's first LO would be numbered `-2`.
 * That can never collide, so the unique index never surfaces it: it fails silently.
 *
 * Injection: `Prisma.raw` receives only allowlist-checked identifiers; `organizationId`,
 * `anchorId` and the LIKE pattern are bound parameters. The anchor's number is read from
 * the database, never interpolated into SQL.
 */
export async function allocateAnchoredNumber(
  tx: Prisma.TransactionClient | PrismaClient,
  input: AnchoredNumberInput,
): Promise<{ number: string; seq: number }> {
  const {
    organizationId,
    anchorTable,
    anchorColumn,
    anchorId,
    anchorNumber: expectedAnchorNumber,
    documentPrefix = 'LO',
    documentTable = 'logistic_orders',
  } = input;

  assertAllowlisted('anchor table', anchorTable, ANCHOR_TABLES);
  assertAllowlisted('anchor column', anchorColumn, ANCHOR_COLUMNS);
  assertAllowlisted('document table', documentTable, new Set<string>(DOCUMENT_TABLES));

  // Both identifiers are allowlisted, but they must also describe the SAME anchor:
  // `jobs` + `customer_id` would otherwise lock a job and sequence a customer.
  const anchor = ANCHOR_BY_TABLE.get(anchorTable);
  if (!anchor || anchor.column !== anchorColumn) {
    throw new Error(
      `Refusing to build anchored-numbering SQL: anchor column "${anchorColumn}" does not belong to anchor table "${anchorTable}"`,
    );
  }

  // Serialize every allocation against this anchor, prove the anchor is ours, and read
  // the anchor's own number off the LOCKED row — the string we mint must describe the
  // row we hold the lock on, never a caller-supplied number that may disagree with it.
  const locked = await tx.$queryRaw<Array<{ id: string; anchor_number: string }>>`
    SELECT id, ${Prisma.raw(anchor.numberColumn)} AS anchor_number
    FROM ${Prisma.raw(anchorTable)}
    WHERE id = ${anchorId}::uuid AND organization_id = ${organizationId}::uuid
    FOR NO KEY UPDATE
  `;
  if (locked.length === 0) {
    throw new Error(`Anchor ${anchorTable}/${anchorId} not found in organization ${organizationId}`);
  }

  const anchorNumber = locked[0].anchor_number;
  if (expectedAnchorNumber !== undefined && expectedAnchorNumber !== anchorNumber) {
    throw new Error(
      `Anchor number mismatch: caller passed "${expectedAnchorNumber}" but ${anchorTable}/${anchorId} is "${anchorNumber}"`,
    );
  }

  // The rows this anchor actually shaped — see "Sequence domain" above. Bound as a
  // parameter; the anchor number is never spliced into the statement text.
  const numberPattern = `${escapeLikeLiteral(documentPrefix)}-${escapeLikeLiteral(anchorNumber)}-%`;

  // `seq` / `number` are the document-table column names; both are literals here rather
  // than allowlist lookups because DOCUMENT_TABLES is the closed set that must expose
  // exactly this pair (spec §11 build note c).
  const rows = await tx.$queryRaw<Array<{ next_seq: number }>>`
    SELECT GREATEST(
             COALESCE(MAX(seq), 0),
             COALESCE(MAX((substring(number FROM '[0-9]+$'))::int), 0)
           ) + 1 AS next_seq
    FROM ${Prisma.raw(documentTable)}
    WHERE organization_id = ${organizationId}::uuid
      AND ${Prisma.raw(anchorColumn)} = ${anchorId}::uuid
      AND number LIKE ${numberPattern}
  `;
  const seq = Number(rows[0]?.next_seq ?? 1);

  return { number: `${documentPrefix}-${anchorNumber}-${seq}`, seq };
}

/** Anchor FK columns as they appear on a document row / create payload. */
export type AnchorIds = Partial<Record<AnchorColumn, string | null | undefined>>;

/**
 * Pick the anchor that shapes the number, per ANCHOR_PRECEDENCE.
 *
 * Returns `null` when no anchor is set — the caller then falls back to the flat
 * `allocateNumber` (standalone `LO00001`).
 */
export function pickAnchor(
  anchors: AnchorIds,
): { kind: AnchorKind; id: string; table: AnchorTable; column: AnchorColumn } | null {
  for (const kind of ANCHOR_PRECEDENCE) {
    const { table, column } = ANCHORS[kind];
    const id = anchors[column];
    if (id) return { kind, id, table, column };
  }
  return null;
}

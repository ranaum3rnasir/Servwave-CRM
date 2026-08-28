#!/usr/bin/env tsx
/**
 * Estimate-container backfill — one-off script (editable record IDs
 * foundation, SERV10X-61 follow-up).
 *
 * Recovers Estimate.container_kind/container_seq for existing container-style
 * estimates ("<parentNumber>-<seq>", e.g. "L00005-1", "698159-3") by
 * re-deriving the parent number from the estimate_number string and matching
 * it against the org's own Lead/Customer/Job number columns. A flat/legacy
 * estimate number (no trailing "-<digits>" suffix — "E00001", a bare
 * Workiz-imported "698470") is left alone entirely.
 *
 * ALL work runs inside runWithOrg(orgId): with DB_TENANT_GUARD=on a standalone
 * script has no request context, so every query would otherwise fail CLOSED
 * (zero rows) — see src/lib/estimate-container-backfill.ts and
 * src/lib/tenant-context.ts. The core logic lives there; this file is just the
 * argv/print wrapper (precedent: scripts/ctm-backfill.ts).
 *
 * Usage:
 *   npm run backfill:estimate-containers -- --org=<uuid> [--dry-run]
 *
 *   --org      required — the ServWave organization id to backfill
 *   --dry-run  classify + count only; ZERO estimate.update calls
 *
 * Ambiguity guard: if any estimate's parsed parent number matches more than
 * one candidate across Lead/Customer/Job for this org, the run refuses to
 * write ANYTHING (resolved rows included) and throws — this is intentional,
 * not a bug. Resolve the collision manually (the error lists every ambiguous
 * row) and re-run.
 *
 * Exit codes: 0 = run completed (unmatched rows are expected and reported,
 * not fatal); 1 = --org missing/malformed, or the ambiguity guard threw.
 */
import { defaultDeps, runEstimateContainerBackfillForOrg } from '../src/lib/estimate-container-backfill';

function argValue(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orgId = argValue(args, '--org');
  const dryRun = args.includes('--dry-run');

  if (!orgId || !UUID_RE.test(orgId)) {
    console.error('Usage: npm run backfill:estimate-containers -- --org=<uuid> [--dry-run]');
    process.exit(1);
    return;
  }

  console.log(`Estimate-container backfill — org=${orgId}${dryRun ? ' (dry-run)' : ''}`);

  const { counters, unmatched, ambiguous } = await runEstimateContainerBackfillForOrg(defaultDeps(), {
    orgId,
    dryRun,
  });

  console.log(`\nBackfill ${dryRun ? 'dry-run ' : ''}complete:`);
  console.log(`  scanned:   ${counters.scanned}`);
  console.log(`  resolved:  ${counters.resolved}`);
  console.log(`  unmatched: ${counters.unmatched}`);
  console.log(`  ambiguous: ${counters.ambiguous}`);

  if (unmatched.length > 0) {
    console.log('\nUnmatched (no candidate parent found — left untouched):');
    for (const u of unmatched) console.log(`  - ${u.id} (${u.estimateNumber})`);
  }

  // Reaching here with ambiguous.length > 0 is unreachable in practice — the
  // guard inside runEstimateContainerBackfillForOrg throws first — but listed
  // defensively so a future refactor that softens the guard still prints them.
  if (ambiguous.length > 0) {
    console.log('\nAmbiguous (multiple candidate parents — left untouched):');
    for (const a of ambiguous) {
      const candidateList = a.candidates.map((c) => `${c.kind}:${c.id}`).join(', ');
      console.log(`  - ${a.id} (${a.estimateNumber}): ${candidateList}`);
    }
  }
}

// Only run when executed directly (not when imported by tests) — same guard as
// scripts/ctm-backfill.ts.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Backfill failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

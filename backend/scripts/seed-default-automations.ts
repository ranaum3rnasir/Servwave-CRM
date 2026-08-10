#!/usr/bin/env tsx
/**
 * Seed every DEFAULT_AUTOMATIONS entry (services/automations/defaultAutomations.ts)
 * for one org, or every org. Idempotent — safe to re-run; only missing
 * builtin_keys are created (seedDefaultAutomationsForOrg checks first).
 *
 * Every seeded workflow is PUBLISHED; whether it lands enabled comes from the
 * registry's per-entry `seed_enabled`. An entry only carries `seed_enabled:
 * true` in the same change that DELETES the hard-coded sender it replaces, so
 * running this can never double-email a customer. (It is read from the registry
 * rather than hardcoded off because the seeder skips existing rows outright —
 * anything seeded disabled could never be enabled by re-running it.)
 *
 * Entitlement-gated (#1069): an org not entitled to `automations` gets nothing
 * seeded, dry-run or real - reported separately below rather than folded into
 * "already present", since the reason is plan, not prior state. This is the
 * one-way door: a row created for an unentitled org can't be corrected by
 * re-running this (the seeder skips existing rows outright), so seeding it is
 * the mistake to prevent, not a mistake to clean up later.
 *
 * Usage (precedent: scripts/ctm-backfill.ts):
 *   npm run automations:seed-defaults -- [--org=<uuid>] [--dry-run]
 *
 *   --org      scope to one organization id; omitted = every org
 *   --dry-run  report which builtin_keys WOULD be created, write nothing
 */
import { prisma } from '../src/lib/prisma';
import { hasFeature } from '../src/lib/entitlements/resolve';
import { seedDefaultAutomationsForOrg } from '../src/services/automations/seedDefaultAutomations';
import { DEFAULT_AUTOMATIONS } from '../src/services/automations/defaultAutomations';

function argValue(args: string[], flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : undefined;
}

async function dryRunOrg(orgId: string): Promise<{ created: string[]; skipped: string[]; entitled: boolean }> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { plan: true, trial_ends_at: true, feature_overrides: true },
  });
  const entitlementSource = org && { ...org, feature_overrides: org.feature_overrides as Record<string, unknown> | null };
  if (!entitlementSource || !hasFeature(entitlementSource, 'automations')) {
    return { created: [], skipped: DEFAULT_AUTOMATIONS.map((d) => d.builtin_key), entitled: false };
  }

  const created: string[] = [];
  const skipped: string[] = [];
  for (const def of DEFAULT_AUTOMATIONS) {
    const existing = await prisma.workflow.findFirst({
      where: { organization_id: orgId, builtin_key: def.builtin_key },
      select: { id: true },
    });
    (existing ? skipped : created).push(def.builtin_key);
  }
  return { created, skipped, entitled: true };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const orgId = argValue(args, '--org');
  const dryRun = args.includes('--dry-run');

  const orgs = orgId
    ? [{ id: orgId }]
    : await prisma.organization.findMany({ select: { id: true, name: true } });

  if (orgId && orgs.length === 0) {
    console.error(`Organization ${orgId} not found`);
    process.exit(1);
  }

  console.log(
    `Seeding ${DEFAULT_AUTOMATIONS.length} default automations across ${orgs.length} org(s)${dryRun ? ' (dry-run)' : ''}`,
  );

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalNotEntitled = 0;
  for (const org of orgs) {
    const label = 'name' in org ? `${org.name} (${org.id})` : org.id;
    const result = dryRun ? await dryRunOrg(org.id) : await seedDefaultAutomationsForOrg(org.id);
    totalCreated += result.created.length;
    if (!result.entitled) {
      totalNotEntitled++;
      console.log(`  ${label}: not entitled to automations (plan) - 0 seeded`);
      continue;
    }
    totalSkipped += result.skipped.length;
    if (result.created.length > 0) {
      console.log(`  ${label}: +${result.created.length} (${result.created.join(', ')})`);
    }
  }

  console.log(
    `\n${dryRun ? 'Dry-run' : 'Seed'} complete: ${totalCreated} created, ${totalSkipped} already present, ${totalNotEntitled} org(s) not entitled`,
  );
}

// Only run when executed directly (not when imported by tests) — same guard as scripts/ctm-backfill.ts.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

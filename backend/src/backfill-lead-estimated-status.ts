/**
 * One-time backfill: transition leads to ESTIMATED where an estimate was sent
 * but the lead status was never updated (bug prior to fix in PR #75).
 *
 * Targets leads in NEW or CONTACTED that have at least
 * one estimate that was sent (status not DRAFT or ARCHIVED).
 *
 * Run with: cd backend && npx tsx src/backfill-lead-estimated-status.ts
 * Dry run:  cd backend && DRY_RUN=true npx tsx src/backfill-lead-estimated-status.ts
 */
import { prisma } from './lib/prisma';

const DRY_RUN = process.env.DRY_RUN === 'true';

async function main() {
  console.log(`Starting lead status backfill${DRY_RUN ? ' (DRY RUN — no writes)' : ''}...\n`);

  const leads = await prisma.lead.findMany({
    where: {
      status: { in: ['NEW', 'CONTACTED'] },
      estimates: {
        some: {
          status: { notIn: ['DRAFT', 'ARCHIVED'] },
        },
      },
    },
    select: {
      id: true,
      lead_number: true,
      status: true,
      organization_id: true,
      estimates: {
        where: { status: { notIn: ['DRAFT', 'ARCHIVED'] } },
        select: { estimate_number: true, status: true },
        orderBy: { created_at: 'asc' },
        take: 1,
      },
    },
  });

  if (leads.length === 0) {
    console.log('No leads to update — all clean.');
    return;
  }

  console.log(`Found ${leads.length} lead(s) to update:\n`);
  for (const lead of leads) {
    const est = lead.estimates[0];
    console.log(`  ${lead.lead_number}  ${lead.status} → ESTIMATED  (estimate ${est.estimate_number} is ${est.status})`);
  }

  if (DRY_RUN) {
    console.log('\nDry run complete — no changes written.');
    return;
  }

  console.log('\nApplying updates...');
  for (const lead of leads) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { status: 'ESTIMATED' },
    });
    console.log(`  ✓ ${lead.lead_number} → ESTIMATED`);
  }

  console.log(`\nBackfill complete — ${leads.length} lead(s) updated.`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

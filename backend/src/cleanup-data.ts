/**
 * Data Cleanup Script
 *
 * Renames test data in the database to use realistic names and short ID formats.
 * Run with: cd backend && npx tsx src/cleanup-data.ts
 */
import { prisma } from './lib/prisma';

// ── Name pools ──────────────────────────────────────────────────────────

const FIRST_NAMES = ['James', 'Maria', 'Robert', 'Sarah', 'Michael', 'Jennifer', 'David', 'Lisa', 'Carlos', 'Emily', 'Daniel', 'Rachel', 'Thomas', 'Nicole', 'Ahmed', 'Olivia', 'Kevin', 'Anna', 'Marcus', 'Sofia'];
const LAST_NAMES = ['Johnson', 'Martinez', 'Williams', 'Chen', 'Thompson', 'Anderson', 'Rodriguez', 'Taylor', 'Mitchell', 'Garcia', 'Davis', 'Wilson', 'Brown', 'Lee', 'Harris', 'Clark', 'Lewis', 'Young', 'Scott', 'Baker'];

const TECH_FIRST = ['Mike', 'Jake', 'Sam', 'Chris', 'Alex', 'Ryan', 'Nick', 'Tony', 'Ben', 'Matt'];
const TECH_LAST = ['Rodriguez', 'Thompson', 'Chen', 'Miller', 'Davis', 'Wilson', 'Garcia', 'Martinez', 'Taylor', 'Anderson'];

// ── Helpers ─────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(5, '0');
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting data cleanup...\n');

  await prisma.$transaction(async (tx) => {
    // ── A) Rename entity numbers ──────────────────────────────────────

    // Jobs
    const jobs = await tx.job.findMany({ orderBy: { created_at: 'asc' }, select: { id: true, job_number: true } });
    for (let i = 0; i < jobs.length; i++) {
      const newNum = `J${pad(i + 1)}`;
      if (jobs[i].job_number !== newNum) {
        await tx.job.update({ where: { id: jobs[i].id }, data: { job_number: newNum } });
        console.log(`  Job: ${jobs[i].job_number} → ${newNum}`);
      }
    }

    // Leads
    const leads = await tx.lead.findMany({ orderBy: { created_at: 'asc' }, select: { id: true, lead_number: true } });
    for (let i = 0; i < leads.length; i++) {
      const newNum = `L${pad(i + 1)}`;
      if (leads[i].lead_number !== newNum) {
        await tx.lead.update({ where: { id: leads[i].id }, data: { lead_number: newNum } });
        console.log(`  Lead: ${leads[i].lead_number} → ${newNum}`);
      }
    }

    // Estimates
    const estimates = await tx.estimate.findMany({ orderBy: { created_at: 'asc' }, select: { id: true, estimate_number: true } });
    for (let i = 0; i < estimates.length; i++) {
      const newNum = `E${pad(i + 1)}`;
      if (estimates[i].estimate_number !== newNum) {
        await tx.estimate.update({ where: { id: estimates[i].id }, data: { estimate_number: newNum } });
        console.log(`  Estimate: ${estimates[i].estimate_number} → ${newNum}`);
      }
    }

    // Invoices
    const invoices = await tx.invoice.findMany({ orderBy: { created_at: 'asc' }, select: { id: true, invoice_number: true } });
    for (let i = 0; i < invoices.length; i++) {
      const newNum = `I${pad(i + 1)}`;
      if (invoices[i].invoice_number !== newNum) {
        await tx.invoice.update({ where: { id: invoices[i].id }, data: { invoice_number: newNum } });
        console.log(`  Invoice: ${invoices[i].invoice_number} → ${newNum}`);
      }
    }

    console.log(`\nRenamed ${jobs.length} jobs, ${leads.length} leads, ${estimates.length} estimates, ${invoices.length} invoices.\n`);

    // ── B) Rename customers ───────────────────────────────────────────

    const customers = await tx.customer.findMany({ orderBy: { created_at: 'asc' }, select: { id: true, first_name: true, last_name: true } });
    for (let i = 0; i < customers.length; i++) {
      const first = FIRST_NAMES[i % FIRST_NAMES.length];
      const last = LAST_NAMES[(i + 3) % LAST_NAMES.length];
      const email = `${first.toLowerCase()}.${last.toLowerCase()}@example.com`;
      await tx.customer.update({
        where: { id: customers[i].id },
        data: { first_name: first, last_name: last, email },
      });
      console.log(`  Customer: ${customers[i].first_name} ${customers[i].last_name} → ${first} ${last}`);
    }

    console.log(`\nRenamed ${customers.length} customers.\n`);

    // ── C) Rename non-admin users ─────────────────────────────────────

    const users = await tx.user.findMany({
      where: { role: { not: 'ADMIN' } },
      orderBy: { created_at: 'asc' },
      select: { id: true, first_name: true, last_name: true },
    });
    for (let i = 0; i < users.length; i++) {
      const first = TECH_FIRST[i % TECH_FIRST.length];
      const last = TECH_LAST[(i + 3) % TECH_LAST.length];
      await tx.user.update({
        where: { id: users[i].id },
        data: { first_name: first, last_name: last },
      });
      console.log(`  User: ${users[i].first_name} ${users[i].last_name} → ${first} ${last}`);
    }

    console.log(`\nRenamed ${users.length} non-admin users.\n`);
  }, { timeout: 120000 }); // 2 minute timeout for large datasets

  console.log('Data cleanup complete.');
}

main()
  .catch((err) => {
    console.error('Cleanup failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

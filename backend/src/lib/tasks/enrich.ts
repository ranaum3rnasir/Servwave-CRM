import { prisma } from '../prisma';

export function userFullName(u: { first_name?: string | null; last_name?: string | null }): string {
  return `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
}

export function customerLabel(c: { company_name?: string | null; first_name?: string | null; last_name?: string | null; customer_number: string }): string {
  if (c.company_name) return c.company_name;
  const person = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return person || c.customer_number;
}

const k = (t: string, id: string) => `${t}:${id}`;

export async function resolveEntityLabels(orgId: string, refs: { type: string; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const by: Record<string, string[]> = {};
  for (const r of refs) if (r.type && r.id) (by[r.type] ??= []).push(r.id);

  if (by.JOB?.length) {
    const rows = await prisma.job.findMany({ where: { id: { in: by.JOB }, organization_id: orgId }, select: { id: true, job_number: true, job_type: true } });
    rows.forEach((j) => out.set(k('JOB', j.id), j.job_type ? `${j.job_number} · ${j.job_type}` : j.job_number));
  }
  if (by.LEAD?.length) {
    const rows = await prisma.lead.findMany({ where: { id: { in: by.LEAD }, organization_id: orgId }, select: { id: true, lead_number: true, job_type: true } });
    rows.forEach((l) => out.set(k('LEAD', l.id), l.job_type ? `${l.lead_number} · ${l.job_type}` : l.lead_number));
  }
  if (by.ESTIMATE?.length) {
    const rows = await prisma.estimate.findMany({ where: { id: { in: by.ESTIMATE }, organization_id: orgId }, select: { id: true, estimate_number: true } });
    rows.forEach((e) => out.set(k('ESTIMATE', e.id), e.estimate_number));
  }
  if (by.CUSTOMER?.length) {
    const rows = await prisma.customer.findMany({ where: { id: { in: by.CUSTOMER }, organization_id: orgId }, select: { id: true, company_name: true, first_name: true, last_name: true, customer_number: true } });
    rows.forEach((c) => out.set(k('CUSTOMER', c.id), customerLabel(c)));
  }
  return out;
}

export async function resolveUserNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const rows = await prisma.user.findMany({ where: { id: { in: unique }, organization_id: orgId }, select: { id: true, first_name: true, last_name: true } });
  rows.forEach((u) => out.set(u.id, userFullName(u)));
  return out;
}

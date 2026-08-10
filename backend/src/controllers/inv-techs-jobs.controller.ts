import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';

// ─── Mock-shape types (the frontend API contract) ──────────
// These mirror frontend/src/lib/api/_mock/inventory/{techs,jobs}.ts exactly.

type TechRole = 'field_tech' | 'warehouse_lead' | 'counter' | 'subcontractor';

type Tech = {
  id: string;
  name: string;
  email?: string;
  role: TechRole;
  branch: string;
  vehicle?: string;
  primaryTrade?: 'locksmith' | 'door' | 'security' | 'hvac' | 'plumbing';
  certs?: string[];
};

type InventoryJobStatus = 'scheduled' | 'in_progress' | 'completed' | 'on_hold';

type InventoryJob = {
  id: string;
  jobNumber: string;
  customer: string;
  site: string;
  trade: 'locksmith' | 'door' | 'security' | 'hvac' | 'plumbing' | 'multi';
  scheduledFor?: string;
  assignedTechId?: string;
  status: InventoryJobStatus;
  notes?: string;
};

// ─── Mappers (snake_case Prisma row → mock camelCase shape) ─

// The Prisma Role enum has no 1:1 mapping to the prototype's field-roster roles.
// TECHNICIAN → field_tech; everyone else (ADMIN/SALES/DISPATCHER) → counter,
// which is the closest "non-field" role the prototype models.
function mapUserRoleToTechRole(role: string): TechRole {
  return role === 'TECHNICIAN' ? 'field_tech' : 'counter';
}

function mapUserToTech(u: {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  department: { name: string } | null;
}): Tech {
  return {
    id: u.id,
    name: `${u.first_name} ${u.last_name}`.trim(),
    // Real inbox from the user directory — the pickup-ticket composer sends here
    // (replaces the old name-derived fake address).
    email: u.email,
    role: mapUserRoleToTechRole(u.role),
    branch: u.department?.name ?? '',
    // vehicle / primaryTrade / certs have no source columns in the Alpha schema
    // (they live in the prototype seed only). Omit them — all optional in the type.
    certs: [],
  };
}

// JobStatus (Prisma) → the prototype's 4-state board status.
//
// Spec B1 (Task 5, B-8): EN_ROUTE/ON_SITE already map correctly to 'in_progress' -- no bug here.
// CANCELLED -> 'on_hold' and UNASSIGNED -> 'scheduled' are deliberate mismatches, NOT left to
// widen: 'on_hold' is the closest of this board's four states to cancelled, and there is no
// board state for "unassigned". Documented here so the next reader does not re-litigate it.
function mapJobStatus(status: string): InventoryJobStatus {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'IN_PROGRESS':
    case 'EN_ROUTE':
    case 'ON_SITE':
      return 'in_progress';
    case 'CANCELLED':
      return 'on_hold';
    case 'UNASSIGNED':
    case 'SCHEDULED':
    default:
      return 'scheduled';
  }
}

function mapJobToInventoryJob(j: {
  id: string;
  job_number: string;
  status: string;
  scheduled_start: Date | null;
  assignees: { user_id: string }[];
  scope_notes: string | null;
  customer: { company_name: string | null; first_name: string | null; last_name: string | null };
  service_location: {
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    zip: string;
  };
}): InventoryJob {
  const customerName =
    j.customer.company_name ||
    `${j.customer.first_name ?? ''} ${j.customer.last_name ?? ''}`.trim() ||
    '';

  const loc = j.service_location;
  const site = [
    loc.address_line1,
    loc.address_line2,
    `${loc.city}, ${loc.state} ${loc.zip}`.trim(),
  ]
    .filter(Boolean)
    .join(', ');

  const out: InventoryJob = {
    id: j.id,
    jobNumber: j.job_number,
    customer: customerName,
    site,
    // The Alpha Job model has no trade column; the prototype defaults cross-trade
    // jobs to "multi". Surface every job as multi until a trade field exists.
    trade: 'multi',
    status: mapJobStatus(j.status),
  };

  if (j.scheduled_start) out.scheduledFor = j.scheduled_start.toISOString();
  // The prototype's single-tech board contract: surface the first crew member.
  if (j.assignees.length) out.assignedTechId = j.assignees[0].user_id;
  if (j.scope_notes) out.notes = j.scope_notes;

  return out;
}

// ─── Handlers ──────────────────────────────────────────────

// GET /api/inventory/techs — active staff/users mapped to the Tech shape.
export async function listTechs(req: Request, res: Response) {
  try {
    const users = await prisma.user.findMany({
      where: { ...tenantWhere(req), is_active: true },
      orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
      include: { department: { select: { name: true } } },
    });

    const techs = users.map(mapUserToTech);

    res.json({ techs });
  } catch (err) {
    logger.error('Failed to list techs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/inventory/jobs — jobs mapped to the InventoryJob shape.
export async function listInventoryJobs(req: Request, res: Response) {
  try {
    const rows = await prisma.job.findMany({
      where: tenantWhere(req),
      orderBy: [{ scheduled_start: 'asc' }, { job_number: 'asc' }],
      include: {
        customer: { select: { company_name: true, first_name: true, last_name: true } },
        assignees: { select: { user_id: true } },
        service_location: {
          select: {
            address_line1: true,
            address_line2: true,
            city: true,
            state: true,
            zip: true,
          },
        },
      },
    });

    const jobs = rows.map(mapJobToInventoryJob);

    res.json({ jobs });
  } catch (err) {
    logger.error('Failed to list inventory jobs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/inventory/jobs/:id — single job in the InventoryJob shape.
export async function getInventoryJob(req: Request, res: Response) {
  try {
    const row = await prisma.job.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        customer: { select: { company_name: true, first_name: true, last_name: true } },
        assignees: { select: { user_id: true } },
        service_location: {
          select: {
            address_line1: true,
            address_line2: true,
            city: true,
            state: true,
            zip: true,
          },
        },
      },
    });

    if (!row) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.json({ job: mapJobToInventoryJob(row) });
  } catch (err) {
    logger.error('Failed to get inventory job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

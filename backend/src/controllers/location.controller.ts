import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { writeSettingsAudit, logAudit } from '../lib/audit';

const param = (req: Request, name: string): string => req.params[name] as string;

export const createLocationSchema = z
  .object({
    name: z.string().min(1).max(120),
    code: z.string().max(20).nullable().optional(),
    address_line1: z.string().max(200).optional(),
    address_line2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    postal_code: z.string().max(20).optional(),
    country: z.string().length(2).optional(),
    timezone: z.string().max(64).optional(),
    phone: z.string().max(50).optional(),
    manager_id: z.string().uuid().nullable().optional(),
  })
  .strict();

// #107 (C2) — Edit loads the raw API row, which carries server-echoed read-only
// keys (id/created_at/updated_at/manager/_count) and `null` optionals. Strip
// unknown keys (instead of strict-400) and accept `null` for the optional string
// fields so a full-row PATCH round-trips. `manager_id` is already nullable.
export const updateLocationSchema = createLocationSchema
  .partial()
  .extend({
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(50).nullable().optional(),
    postal_code: z.string().max(20).nullable().optional(),
    country: z.string().length(2).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
  })
  .strip();

export const listLocations = async (req: Request, res: Response) => {
  try {
    const locations = await prisma.location.findMany({
      where: { ...tenantWhere(req) },
      orderBy: { name: 'asc' },
      include: {
        manager: { select: { id: true, first_name: true, last_name: true } },
        _count: { select: { members: true } },
      },
    });
    res.json(locations);
  } catch (err) {
    logger.error('listLocations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createLocation = async (req: Request, res: Response) => {
  try {
    const data = req.body as z.infer<typeof createLocationSchema>;
    const created = await prisma.location.create({ data: { ...data, ...tenantWhere(req) } });
    await writeSettingsAudit(req, 'location.created', { location_id: created.id, name: created.name });
    void logAudit({ req, action: 'location.created', resourceType: 'Location', resourceId: created.id });
    res.status(201).json(created);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A location with that code already exists' });
      return;
    }
    logger.error('createLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateLocation = async (req: Request, res: Response) => {
  try {
    const data = req.body as z.infer<typeof updateLocationSchema>;
    const result = await prisma.location.updateMany({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }
    const location = await prisma.location.findFirst({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    await writeSettingsAudit(req, 'location.updated', { location_id: param(req, 'id') });
    void logAudit({ req, action: 'location.updated', resourceType: 'Location', resourceId: param(req, 'id') });
    res.json(location);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A location with that code already exists' });
      return;
    }
    logger.error('updateLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteLocation = async (req: Request, res: Response) => {
  try {
    const referencing = await prisma.user.count({
      where: { location_id: param(req, 'id'), ...tenantWhere(req) },
    });
    if (referencing > 0) {
      res.status(409).json({ error: `Cannot delete: ${referencing} user(s) are assigned to this location` });
      return;
    }
    const result = await prisma.location.deleteMany({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (result.count === 0) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }
    await writeSettingsAudit(req, 'location.deleted', { location_id: param(req, 'id') });
    void logAudit({ req, action: 'location.deleted', resourceType: 'Location', resourceId: param(req, 'id') });
    res.status(204).send();
  } catch (err) {
    logger.error('deleteLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

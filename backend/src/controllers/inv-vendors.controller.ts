import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { normalizePhone } from '../lib/customer-duplicate';

// ─── Zod Schemas ───────────────────────────────────────

const transmitMethodEnum = z.enum(['email', 'edi', 'portal', 'phone']);

// #511: store vendor phones digits-only so comms-identity matchByPhone keeps
// resolving inbound calls/SMS. Lenient: no length refine (legacy free-text
// must not 400); blank/non-digit values clear to null.
const lenientVendorPhone = (v: string | null | undefined) =>
  v == null ? v : normalizePhone(v);

const vendorContactSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(50).optional().transform(lenientVendorPhone),
  role: z.string().max(200).optional(),
});

export const createVendorSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  category: z.string().min(1, 'Category is required').max(200),
  paymentTerms: z.string().max(100).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  transmitMethod: transmitMethodEnum.optional(),
  transmitMethods: z.array(transmitMethodEnum).optional(),
  contactPersonName: z.string().max(200).nullable().optional(),
  contactEmail: z.string().max(200).nullable().optional(),
  contactPhone: z.string().max(50).nullable().optional().transform(lenientVendorPhone),
  additionalContacts: z.array(vendorContactSchema).optional(),
  accountNumber: z.string().max(100).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  pickupAddress: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

// The frontend upsert hook posts a Partial<Vendor>; when an `id` is present we
// update, otherwise we create. Everything is optional on the wire and the
// handler decides the path.
//
// `id` must be a real UUID: `vendors.id` is a Postgres UUID column, and the
// dialog stamps freshly-created vendors with a client-side placeholder id
// (`vnd_new_<timestamp>`) before the first save. Without this check that
// placeholder reaches `prisma.vendor.findFirst({ where: { id } })`, which
// throws on the malformed UUID (Prisma P2023) instead of failing validation —
// turning every "Add Vendor" save into an unhandled 500.
export const upsertVendorSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(200).optional(),
  paymentTerms: z.string().max(100).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  transmitMethod: transmitMethodEnum.optional(),
  transmitMethods: z.array(transmitMethodEnum).optional(),
  contactPersonName: z.string().max(200).nullable().optional(),
  contactEmail: z.string().max(200).nullable().optional(),
  contactPhone: z.string().max(50).nullable().optional().transform(lenientVendorPhone),
  additionalContacts: z.array(vendorContactSchema).optional(),
  accountNumber: z.string().max(100).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  pickupAddress: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});


// ─── Mapper: snake_case Prisma row → camelCase mock `Vendor` shape ─────────
//
// The frontend is typed against the `Vendor` mock type (camelCase keys, nested
// `additionalContacts`). The Prisma row uses snake_case columns + a `contacts`
// relation. This mapper bridges the two so the typed frontend works unchanged.

function mapContact(c: any) {
  const out: Record<string, unknown> = { id: c.id };
  if (c.name != null) out.name = c.name;
  if (c.email != null) out.email = c.email;
  if (c.phone != null) out.phone = c.phone;
  if (c.role != null) out.role = c.role;
  return out;
}

function toVendorDto(row: any) {
  const transmitMethods: string[] | undefined = Array.isArray(row.transmit_methods)
    ? (row.transmit_methods as string[])
    : undefined;

  const dto: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    category: row.category,
    paymentTerms: row.payment_terms,
    leadTimeDays: row.lead_time_days,
    transmitMethod: row.transmit_method,
  };

  if (transmitMethods && transmitMethods.length > 0) dto.transmitMethods = transmitMethods;
  if (row.contact_person_name != null) dto.contactPersonName = row.contact_person_name;
  if (row.contact_email != null) dto.contactEmail = row.contact_email;
  if (row.contact_phone != null) dto.contactPhone = row.contact_phone;
  if (Array.isArray(row.contacts) && row.contacts.length > 0) {
    dto.additionalContacts = row.contacts.map(mapContact);
  }
  if (row.account_number != null) dto.accountNumber = row.account_number;
  if (row.website != null) dto.website = row.website;
  if (row.pickup_address != null) dto.pickupAddress = row.pickup_address;
  if (row.notes != null) dto.notes = row.notes;
  if (row.status != null) dto.status = row.status;

  return dto;
}

// Translate the camelCase request body into a snake_case Prisma `data` object.
// Only keys present on the body are written so PATCH-style upserts don't clobber
// untouched columns.
function toVendorData(body: any) {
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.category !== undefined) data.category = body.category;
  if (body.paymentTerms !== undefined) data.payment_terms = body.paymentTerms;
  if (body.leadTimeDays !== undefined) data.lead_time_days = body.leadTimeDays;
  if (body.transmitMethod !== undefined) data.transmit_method = body.transmitMethod;
  if (body.transmitMethods !== undefined) data.transmit_methods = body.transmitMethods;
  if (body.contactPersonName !== undefined) data.contact_person_name = body.contactPersonName;
  if (body.contactEmail !== undefined) data.contact_email = body.contactEmail;
  if (body.contactPhone !== undefined) data.contact_phone = body.contactPhone;
  if (body.accountNumber !== undefined) data.account_number = body.accountNumber;
  if (body.website !== undefined) data.website = body.website;
  if (body.pickupAddress !== undefined) data.pickup_address = body.pickupAddress;
  if (body.notes !== undefined) data.notes = body.notes;
  if (body.status !== undefined) data.status = body.status;
  return data;
}

const vendorInclude = { contacts: true } as const;

// ─── Handlers ──────────────────────────────────────────

export async function listVendors(req: Request, res: Response) {
  try {
    const vendors: any = await prisma.vendor.findMany({
      where: tenantWhere(req),
      orderBy: [{ name: 'asc' }],
      include: vendorInclude,
    });

    res.json({ vendors: vendors.map(toVendorDto) });
  } catch (err) {
    logger.error('Failed to list vendors:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getVendor(req: Request, res: Response) {
  try {
    const vendor: any = await prisma.vendor.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: vendorInclude,
    });

    if (!vendor) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }

    res.json({ vendor: toVendorDto(vendor) });
  } catch (err) {
    logger.error('Failed to get vendor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Single upsert endpoint backing the frontend `useUpsertVendor` hook. With an
// `id` it updates the matching tenant-scoped row; without one it creates.
export async function upsertVendor(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const contacts = Array.isArray(req.body.additionalContacts)
      ? req.body.additionalContacts
      : undefined;

    if (req.body.id) {
      const existing = await prisma.vendor.findFirst({
        where: { id: req.body.id, ...tenantWhere(req) },
      });
      if (!existing) {
        res.status(404).json({ error: 'Vendor not found' });
        return;
      }

      const vendor: any = await prisma.$transaction(async (tx) => {
        await tx.vendor.update({
          where: { id: req.body.id },
          data: toVendorData(req.body),
        });

        // Replace the contact set when the caller sends one (the dialog always
        // sends the full list). Omitted → leave contacts untouched.
        if (contacts) {
          await tx.vendorContact.deleteMany({
            where: { vendor_id: req.body.id, ...tenantWhere(req) },
          });
          if (contacts.length > 0) {
            await tx.vendorContact.createMany({
              data: contacts.map((c: any) => ({
                vendor_id: req.body.id,
                name: c.name ?? null,
                email: c.email ?? null,
                phone: c.phone ?? null,
                role: c.role ?? null,
                organization_id: orgId,
              })),
            });
          }
        }

        return tx.vendor.findFirst({
          where: { id: req.body.id, ...tenantWhere(req) },
          include: vendorInclude,
        });
      });

      void logAudit({
        req,
        action: 'inventory.vendor_updated',
        resourceType: 'Vendor',
        resourceId: req.body.id,
        metadata: { fields: Object.keys(req.body) },
      });

      res.json({ vendor: toVendorDto(vendor) });
      return;
    }

    if (!req.body.name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const vendor: any = await prisma.vendor.create({
      data: {
        name: req.body.name,
        category: req.body.category ?? '',
        payment_terms: req.body.paymentTerms ?? '',
        lead_time_days: req.body.leadTimeDays ?? 0,
        transmit_method: req.body.transmitMethod ?? 'email',
        transmit_methods: req.body.transmitMethods ?? undefined,
        contact_person_name: req.body.contactPersonName ?? null,
        contact_email: req.body.contactEmail ?? null,
        contact_phone: req.body.contactPhone ?? null,
        account_number: req.body.accountNumber ?? null,
        website: req.body.website ?? null,
        pickup_address: req.body.pickupAddress ?? null,
        notes: req.body.notes ?? null,
        status: req.body.status ?? 'active',
        organization_id: orgId,
        contacts: contacts && contacts.length > 0
          ? {
              create: contacts.map((c: any) => ({
                name: c.name ?? null,
                email: c.email ?? null,
                phone: c.phone ?? null,
                role: c.role ?? null,
                organization_id: orgId,
              })),
            }
          : undefined,
      },
      include: vendorInclude,
    });

    void logAudit({
      req,
      action: 'inventory.vendor_created',
      resourceType: 'Vendor',
      resourceId: vendor.id,
      metadata: { name: vendor.name },
    });

    res.status(201).json({ vendor: toVendorDto(vendor) });
  } catch (err) {
    logger.error('Failed to upsert vendor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// P2 item 7: canonical DELETE /vendors/:id with a has-POs guard (A-17, QA-610).
// "Archive" is NOT a new state: the existing upsert's status:'inactive' is the
// documented soft-archive flag (pickers already exclude it), so the 409 points
// the client at that toggle instead of a new endpoint.
export async function deleteVendor(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    // `:id` comes from the URL, not the Zod-validated body — a route param
    // never goes through `upsertVendorSchema`. It must still be a real UUID
    // before touching Prisma: `purchase_orders.vendor_id` and `vendors.id` are
    // both UUID columns, and the optimistically-inserted vendor row (added to
    // VendorsPage state before its create response returns) briefly carries
    // the same non-UUID placeholder id the upsert fix above guards against.
    if (!z.string().uuid().safeParse(id).success) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }

    // Guard keyed on the vendor_id FK: post-P2 POs carry it and legacy rows were
    // exact-name backfilled. Name-ambiguous legacy POs keep vendor_id NULL and do
    // not block — the PO retains its `vendor` display string via SetNull (QA-610).
    // Count-then-delete TOCTOU is acceptable for a human admin action (same
    // tolerance as stock set-quantity).
    const poCount = await prisma.purchaseOrder.count({
      where: { vendor_id: id, ...tenantWhere(req) },
    });
    if (poCount > 0) {
      res.status(409).json({
        error: 'VENDOR_HAS_POS',
        message: 'This vendor has purchase orders. Archive it instead.',
        po_count: poCount,
      });
      return;
    }

    // deleteMany with id+org filter is atomic — no TOCTOU window. Contacts
    // cascade via the FK onDelete: Cascade.
    const result = await prisma.vendor.deleteMany({
      where: { id, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Vendor not found' });
      return;
    }

    void logAudit({
      req,
      action: 'inventory.vendor_deleted',
      resourceType: 'Vendor',
      resourceId: id,
    });

    res.json({ message: 'Vendor deleted' });
  } catch (err) {
    logger.error('Failed to delete vendor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

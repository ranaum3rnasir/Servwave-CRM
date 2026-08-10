import { Request, Response } from 'express';
import { z } from 'zod';
import { AttachmentContext, AttachmentEntity } from '@prisma/client';
import { prisma } from '../lib/prisma';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import {
  ATTACHMENTS_BUCKET as STORAGE_BUCKET,
  buildAccessUrl,
  sanitizeAttachmentFilename,
} from '../lib/attachment-access';

// ─── Constants ───────────────────────────────────────────

// Exported (email slice 7): the compose-window multipart upload reuses this
// EXACT list rather than declaring a parallel one that could drift.
export const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime',
  'application/pdf',
];

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — images, HEIC/HEIF, PDF
const MAX_VIDEO_FILE_SIZE = 50 * 1024 * 1024; // 50MB — video/mp4, video/quicktime
const MAX_ENTITY_SIZE = 200 * 1024 * 1024; // 200MB

const VALID_ENTITY_TYPES: AttachmentEntity[] = ['CUSTOMER', 'LEAD', 'ESTIMATE', 'JOB', 'INVOICE'];

// ─── Schemas ─────────────────────────────────────────────

export const updateAttachmentSchema = z.object({
  display_name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
});

// ─── Helpers ─────────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

function validateEntityType(type: string): type is AttachmentEntity {
  return VALID_ENTITY_TYPES.includes(type as AttachmentEntity);
}

async function checkEntityExists(entityType: AttachmentEntity, entityId: string, req: Request): Promise<boolean> {
  const orgFilter = tenantWhere(req);
  switch (entityType) {
    case 'CUSTOMER': return !!(await prisma.customer.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    case 'LEAD':     return !!(await prisma.lead.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    case 'ESTIMATE': return !!(await prisma.estimate.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    case 'JOB':      return !!(await prisma.job.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    case 'INVOICE':  return !!(await prisma.invoice.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    default: return false;
  }
}

export async function checkEntityAccess(entityType: AttachmentEntity, entityId: string, req: Request): Promise<boolean> {
  const { role, id: userId } = req.user!;
  const orgFilter = tenantWhere(req);

  // For ADMIN/DISPATCHER, still enforce org isolation via existence check
  if (role === 'ADMIN' || role === 'DISPATCHER') {
    return checkEntityExists(entityType, entityId, req);
  }

  // Customers are org-shared reference data — any in-org role with an Attachment
  // grant may attach to a customer. Org isolation is enforced via existence.
  if (entityType === 'CUSTOMER') {
    return checkEntityExists(entityType, entityId, req);
  }

  if (role === 'SALES') {
    if (entityType === 'LEAD') {
      const lead = await prisma.lead.findUnique({ where: { id: entityId, ...orgFilter }, select: { lead_assignees: { select: { user_id: true } }, walkthrough_performers: { select: { user_id: true } } } });
      return (lead?.lead_assignees?.some((a) => a.user_id === userId) ?? false) || (lead?.walkthrough_performers?.some((p) => p.user_id === userId) ?? false);
    }
    if (entityType === 'ESTIMATE') {
      const est = await prisma.estimate.findUnique({ where: { id: entityId, ...orgFilter }, select: { lead: { select: { lead_assignees: { select: { user_id: true } } } } } });
      return est?.lead?.lead_assignees?.some((a) => a.user_id === userId) ?? false;
    }
    return false;
  }

  if (role === 'TECHNICIAN') {
    if (entityType === 'JOB') {
      const job = await prisma.job.findUnique({ where: { id: entityId, ...orgFilter }, select: { assignees: { select: { user_id: true } } } });
      return job?.assignees?.some((a) => a.user_id === userId) ?? false;
    }
    if (entityType === 'LEAD') {
      const lead = await prisma.lead.findUnique({ where: { id: entityId, ...orgFilter }, select: { walkthrough_performers: { select: { user_id: true } } } });
      return lead?.walkthrough_performers?.some((p) => p.user_id === userId) ?? false;
    }
    return false;
  }

  return false;
}

// ─── Handlers ────────────────────────────────────────────

export async function listAttachments(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const rows = await prisma.attachment.findMany({
      where: { entity_type: entityType, entity_id: entityId, ...tenantWhere(req) },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        storage_path: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        context: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const includeWalkthrough = req.query.include_walkthrough === 'true';

    const signed = await Promise.all(
      rows.map(async (row) => {
        const { storage_path, ...rest } = row;
        return { ...rest, file_url: await buildAccessUrl(storage_path, row.file_url) };
      }),
    );

    if (!includeWalkthrough || entityType !== 'JOB') {
      res.json({ attachments: signed });
      return;
    }

    // Tag existing job rows with source
    const jobRows = signed.map((a) => ({ ...a, source: 'JOB' as const }));

    // Resolve lead_id through the job's estimate
    const jobRow = await prisma.job.findFirst({
      where: { id: entityId, ...tenantWhere(req) },
      select: { estimate: { select: { lead_id: true } } },
    });
    const leadId = jobRow?.estimate?.lead_id ?? null;

    if (!leadId) {
      res.json({ attachments: jobRows });
      return;
    }

    const wtRows = await prisma.attachment.findMany({
      where: {
        entity_type: 'LEAD',
        entity_id: leadId,
        ...tenantWhere(req),
        context: { in: ['WALKTHROUGH', 'BEFORE_PHOTO', 'DURING_PHOTO', 'AFTER_PHOTO', 'ISSUE_PHOTO'] },
      },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        storage_path: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        context: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const wtSigned = await Promise.all(
      wtRows.map(async (row) => {
        const { storage_path, ...rest } = row;
        return { ...rest, file_url: await buildAccessUrl(storage_path, row.file_url), source: 'WALKTHROUGH' as const };
      }),
    );

    res.json({ attachments: [...jobRows, ...wtSigned] });
  } catch (err) {
    logger.error('List attachments error:', err);
    res.status(500).json({ error: 'Failed to list attachments' });
  }
}

export async function uploadAttachment(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityExists(entityType, entityId, req))) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      res.status(400).json({ error: `File type not allowed. Accepted: JPG, PNG, HEIC, MP4, PDF` });
      return;
    }

    // Magic-byte content sniff: never trust the client-supplied Content-Type
    // header alone (multer derives file.mimetype from it). Reject when the
    // actual bytes are unrecognised or disagree with the declared type (F-35).
    if (!sniffMatchesDeclared(file.buffer, file.mimetype, ALLOWED_MIME_TYPES)) {
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }

    // Validate file size — video gets a higher cap than images/PDF.
    const isVideo = file.mimetype.startsWith('video/');
    const maxSize = isVideo ? MAX_VIDEO_FILE_SIZE : MAX_FILE_SIZE;
    if (file.size > maxSize) {
      res.status(400).json({ error: `File too large. Maximum: ${isVideo ? '50MB' : '25MB'}` });
      return;
    }

    // Validate entity total size
    const existingSize = await prisma.attachment.aggregate({
      where: { entity_type: entityType as AttachmentEntity, entity_id: entityId, ...tenantWhere(req) },
      _sum: { file_size: true },
    });
    const totalSize = (existingSize._sum.file_size || 0) + file.size;
    if (totalSize > MAX_ENTITY_SIZE) {
      res.status(400).json({ error: `Total attachments for this entity would exceed 200MB limit` });
      return;
    }

    // Get metadata from form fields
    const displayName = req.body.display_name;
    const description = req.body.description;
    const context = req.body.context as AttachmentContext | undefined;

    if (!displayName || !displayName.trim()) {
      res.status(400).json({ error: 'display_name is required' });
      return;
    }
    if (description === undefined || description === null) {
      res.status(400).json({ error: 'description is required' });
      return;
    }

    // Upload to Supabase Storage — namespace by org so files are isolated even if
    // bucket privacy is misconfigured. Storage path is the canonical reference.
    const orgId = req.user!.organization_id;
    const safeName = sanitizeAttachmentFilename(file.originalname);
    const storagePath = `${orgId}/${entityType.toLowerCase()}/${entityId}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      logger.error('Supabase storage upload error:', uploadError);
      res.status(500).json({ error: 'Failed to upload file' });
      return;
    }

    // Mint a signed URL for the response — works on both public and private buckets.
    const fileUrl = await buildAccessUrl(storagePath, '');

    // Persist `file_url: ''` rather than the freshly-minted signed URL — the
    // URL expires in 1h and storage_path is the canonical source of truth.
    // listAttachments / deleteAttachment re-mint from storage_path. Avoids
    // stale dead data in the DB column.
    const created = await prisma.attachment.create({
      data: {
        entity_type: entityType as AttachmentEntity,
        entity_id: entityId,
        file_name: file.originalname,
        file_url: '',
        storage_path: storagePath,
        file_type: file.mimetype,
        file_size: file.size,
        display_name: displayName.trim(),
        description: (description || '').trim(),
        context: context && Object.values(AttachmentContext).includes(context) ? context : 'OTHER',
        uploaded_by: req.user!.id,
        organization_id: orgId,
        // Audit: the uploading user. uploaded_by above already names them, but it is a required
        // relation, so it cannot survive DELETE /api/users/:id/permanent - created_by_name can.
        ...createdByUser(req),
      },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        context: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    const attachment = { ...created, file_url: fileUrl };

    // Log timeline event
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: entityType,
        entity_id: entityId,
        event_type: 'ATTACHMENT_UPLOADED',
        description: `File uploaded: ${displayName.trim()}`,
        metadata: { attachment_id: attachment.id, file_type: file.mimetype, context: context || 'OTHER' },
        created_by: req.user!.id,
      },
    });

    res.status(201).json({ attachment });
  } catch (err) {
    logger.error('Upload attachment error:', err);
    res.status(500).json({ error: 'Failed to upload attachment' });
  }
}

export async function updateAttachment(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');
    const attachmentId = param(req, 'attachmentId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const existing = await prisma.attachment.findFirst({
      where: { id: attachmentId, entity_type: entityType as AttachmentEntity, entity_id: entityId, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }

    const { display_name, description } = req.body;
    const attachment = await prisma.attachment.update({
      where: { id: attachmentId },
      data: {
        ...(display_name !== undefined ? { display_name: display_name.trim() } : {}),
        ...(description !== undefined ? { description: description.trim() } : {}),
      },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        context: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    // Log timeline event
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: entityType,
        entity_id: entityId,
        event_type: 'ATTACHMENT_UPDATED',
        description: `Attachment updated: ${attachment.display_name}`,
        metadata: { attachment_id: attachmentId },
        created_by: req.user!.id,
      },
    });

    res.json({ attachment });
  } catch (err) {
    logger.error('Update attachment error:', err);
    res.status(500).json({ error: 'Failed to update attachment' });
  }
}

export async function deleteAttachment(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');
    const attachmentId = param(req, 'attachmentId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const existing = await prisma.attachment.findFirst({
      where: { id: attachmentId, entity_type: entityType as AttachmentEntity, entity_id: entityId, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }

    // Prefer canonical storage_path. Legacy rows: parse from the (now obsolete) public URL.
    let storagePath: string | null = existing.storage_path;
    if (!storagePath && existing.file_url) {
      try {
        const url = new URL(existing.file_url);
        const pathParts = url.pathname.split(`/storage/v1/object/public/${STORAGE_BUCKET}/`);
        storagePath = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
      } catch {
        storagePath = null;
      }
    }

    if (storagePath) {
      const { error: deleteError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .remove([storagePath]);

      if (deleteError) {
        logger.warn(`Failed to delete file from storage (continuing): ${deleteError.message}`);
      }
    }

    // Delete record
    await prisma.attachment.delete({ where: { id: attachmentId } });

    // Log timeline event
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: entityType,
        entity_id: entityId,
        event_type: 'ATTACHMENT_DELETED',
        description: `Attachment deleted: ${existing.display_name}`,
        metadata: { attachment_id: attachmentId, file_name: existing.file_name },
        created_by: req.user!.id,
      },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('Delete attachment error:', err);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
}

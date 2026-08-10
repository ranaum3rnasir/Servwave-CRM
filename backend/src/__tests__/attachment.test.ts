import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE, JOB_FIXTURE, LEAD_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  customer: { findUnique: ReturnType<typeof vi.fn> };
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  attachment: {
    findMany: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
};

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
};

// ─── magic-byte fixtures (file-sniff.ts contract) ────────────────────────────
function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
function mp4Buf(size = 16): Buffer {
  const b = Buffer.alloc(size);
  b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1');
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
});

describe('GET /api/attachments/customer/:id', () => {
  it('lists attachments for a CUSTOMER entity (200)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.attachment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([]);
    // entity_type was accepted + uppercased before the query.
    const args = mockPrisma.attachment.findMany.mock.calls[0][0];
    expect(args.where.entity_type).toBe('CUSTOMER');
  });

  it('rejects an unknown entity type (400)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get(`/api/attachments/widget/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
  });
});

describe('GET /api/attachments/JOB/:id?include_walkthrough=true', () => {
  it('JOB attachments include lead walkthrough items when include_walkthrough=true', async () => {
    mockAuthAs('admin');
    // Access gate: job exists
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    // First findMany: JOB's own attachments; Second: LEAD walkthrough attachments
    mockPrisma.attachment.findMany
      .mockResolvedValueOnce([
        {
          id: 'att-job-1',
          file_name: 'job-photo.jpg',
          file_url: 'https://example.com/job-photo.jpg',
          storage_path: null,
          file_type: 'image/jpeg',
          file_size: 12345,
          display_name: null,
          description: null,
          context: 'AFTER_PHOTO',
          created_at: new Date('2026-01-25'),
          uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'att-wt-1',
          file_name: 'walkthrough-photo.jpg',
          file_url: 'https://example.com/walkthrough-photo.jpg',
          storage_path: null,
          file_type: 'image/jpeg',
          file_size: 11111,
          display_name: null,
          description: null,
          context: 'WALKTHROUGH',
          created_at: new Date('2026-01-20'),
          uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
        },
      ]);
    // Job lookup for lead_id
    mockPrisma.job.findFirst.mockResolvedValue({
      estimate: { lead_id: LEAD_FIXTURE.id },
    });

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}?include_walkthrough=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const sources = res.body.attachments.map((a: { source: string }) => a.source);
    expect(sources).toContain('JOB');
    expect(sources).toContain('WALKTHROUGH');

    // Second findMany must have queried LEAD entity with walkthrough contexts
    const secondCall = mockPrisma.attachment.findMany.mock.calls[1][0];
    expect(secondCall.where.entity_type).toBe('LEAD');
    expect(secondCall.where.entity_id).toBe(LEAD_FIXTURE.id);
    expect(secondCall.where.context.in).toContain('WALKTHROUGH');
  });

  it('JOB attachments backward-compat: no source key without include_walkthrough', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.attachment.findMany.mockResolvedValueOnce([
      {
        id: 'att-job-1',
        file_name: 'job-photo.jpg',
        file_url: 'https://example.com/job-photo.jpg',
        storage_path: null,
        file_type: 'image/jpeg',
        file_size: 12345,
        display_name: null,
        description: null,
        context: 'AFTER_PHOTO',
        created_at: new Date('2026-01-25'),
        uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
      },
    ]);

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.attachments).toHaveLength(1);
    // No source key on any row
    expect(res.body.attachments[0]).not.toHaveProperty('source');
    // Only one findMany call (no lead lookup)
    expect(mockPrisma.attachment.findMany.mock.calls).toHaveLength(1);
  });

  it('JOB attachments: only job rows returned when job has no estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    // Own attachments (empty)
    mockPrisma.attachment.findMany.mockResolvedValueOnce([]);
    // Job lookup returns no estimate
    mockPrisma.job.findFirst.mockResolvedValue({ estimate: null });

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}?include_walkthrough=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Only one attachment.findMany call (no lead query)
    expect(mockPrisma.attachment.findMany.mock.calls).toHaveLength(1);
  });
});

describe('POST /api/attachments/:entityType/:entityId — size caps', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
  });

  it('accepts a video up to 50MB', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'walkthrough clip')
      .field('description', '')
      .attach('file', mp4Buf(50 * 1024 * 1024), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    expect(storage.upload).toHaveBeenCalled();
  });

  it('rejects a video over 50MB (400, not a raw multer 500)', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'walkthrough clip')
      .field('description', '')
      .attach('file', mp4Buf(50 * 1024 * 1024 + 1), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('50MB');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('still rejects a non-video file over 25MB', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'big photo')
      .field('description', '')
      .attach('file', jpegBuf(25 * 1024 * 1024 + 1), { filename: 'big.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('25MB');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('accepts a non-video file at exactly 25MB', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'photo')
      .field('description', '')
      .attach('file', jpegBuf(25 * 1024 * 1024), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(storage.upload).toHaveBeenCalled();
  });
});

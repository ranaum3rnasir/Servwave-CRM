/**
 * A rejected upload has to say WHY (#1605).
 *
 * The .docx outage was invisible from the client: the app-side allow-list, the magic-byte sniff
 * and the size caps all passed, Supabase Storage rejected the object on the bucket's OWN
 * allowed_mime_types, and the handler logged that reason and replaced it with a blanket
 * `500 { error: 'Failed to upload file' }`. Winston is console-only, so on Render the reason was
 * gone. The only way anyone found it was reading the storage logs in the Supabase dashboard.
 *
 * These lock in that the storage error survives into the response with a status that reflects
 * what actually happened, and that a failed DB insert does not leave the object orphaned in the
 * bucket.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  customer: { findUnique: ReturnType<typeof vi.fn> };
  attachment: { aggregate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
};

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}

function upload() {
  return request(app)
    .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
    .set(authHeader('admin'))
    .field('display_name', 'evaluation')
    .field('description', '')
    .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
  mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
  storage.upload.mockResolvedValue({ data: { path: 'test/file.jpg' }, error: null });
  storage.remove.mockResolvedValue({ data: null, error: null });
});

describe('storage rejections reach the client', () => {
  it('reports a bucket mime rejection as 415 and repeats what storage said', async () => {
    storage.upload.mockResolvedValue({
      data: null,
      error: { statusCode: '400', error: 'invalid_mime_type', message: 'mime type application/vnd.openxmlformats-officedocument.wordprocessingml.document is not supported' },
    });

    const res = await upload();

    expect(res.status).toBe(415);
    expect(res.body.error).toContain('mime type');
    expect(res.body.error).toContain('wordprocessingml');
  });

  it('reports an over-size storage rejection as 413', async () => {
    storage.upload.mockResolvedValue({
      data: null,
      error: { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' },
    });

    const res = await upload();

    expect(res.status).toBe(413);
    expect(res.body.error).toContain('maximum allowed size');
  });

  it('reports a duplicate object as 409', async () => {
    storage.upload.mockResolvedValue({
      data: null,
      error: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' },
    });

    expect((await upload()).status).toBe(409);
  });

  it('reports anything else as 502 rather than a bare 500', async () => {
    storage.upload.mockResolvedValue({
      data: null,
      error: { statusCode: '500', error: 'InternalError', message: 'upstream unavailable' },
    });

    const res = await upload();

    expect(res.status).toBe(502);
    expect(res.body.error).toContain('upstream unavailable');
  });

  it('removes the uploaded object when the row insert fails, instead of orphaning it', async () => {
    mockPrisma.attachment.create.mockRejectedValue(new Error('db down'));

    const res = await upload();

    expect(res.status).toBe(500);
    expect(storage.remove).toHaveBeenCalledWith([expect.stringContaining('/customer/')]);
  });
});

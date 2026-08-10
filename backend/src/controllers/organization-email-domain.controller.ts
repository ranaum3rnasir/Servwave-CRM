import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { resend } from '../lib/email';
import { isPlausibleDomainName, apexDomainOf, detectDnsProvider } from '../lib/dns-provider';
import { applyFreshDomainStatus, notifyDomainVerified, OrganizationDomainRow } from '../lib/organization-domain';

/**
 * Guided domain verification (email slice 10) — an org's OWN sending domain,
 * verified via Resend's domain API, as an opt-in alternative to the shared
 * env.EMAIL_FROM_BUSINESS domain (decision 16, unaffected — it stays the
 * default for every org that never sets this up).
 *
 * ALL four endpoints below are ADMIN-only (canDo('update', 'Organization') in
 * organization.routes.ts — the repo's ADMIN-only idiom, CTM/Stripe-connect
 * precedent): this is an org-wide sending-identity change, not a per-user
 * preference. Every query is scoped via tenantWhere(req) — one row per org
 * (OrganizationDomain.organization_id is UNIQUE), so there is no route
 * parameter at all for a cross-org id to leak through.
 */

export const createEmailDomainSchema = z
  .object({
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .refine(isPlausibleDomainName, { message: 'Enter a valid domain name (e.g. mail.example.com)' }),
  })
  .strict();

/** The single response shape every endpoint below returns (except DELETE) —
 * the frontend renders the same "add this DNS record" UI from whichever
 * endpoint it just called. */
function serializeDomain(row: OrganizationDomainRow) {
  return {
    domain: row.domain_name,
    status: row.status,
    records: row.records,
    detected_dns_provider: row.detected_dns_provider,
    verified_at: row.verified_at ? row.verified_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function createEmailDomain(req: Request, res: Response) {
  try {
    if (!resend) {
      res.status(502).json({ error: 'Email provider is not configured' });
      return;
    }
    const existing = await prisma.organizationDomain.findUnique({ where: tenantWhere(req) });
    if (existing) {
      res.status(409).json({
        error: 'A sending domain is already configured for this organization. Remove it before adding a new one.',
      });
      return;
    }

    const { domain } = req.body as { domain: string };
    const { data, error } = await resend.domains.create({ name: domain });
    if (error || !data) {
      res.status(502).json({ error: error?.message ?? 'Failed to create the domain with the email provider' });
      return;
    }

    // Best-effort — never blocks creation on a failed/inconclusive NS lookup.
    const detectedProvider = await detectDnsProvider(apexDomainOf(domain));

    const created = await prisma.organizationDomain.create({
      data: {
        organization_id: req.user!.organization_id,
        domain_name: domain,
        resend_domain_id: data.id,
        status: data.status,
        records: data.records as object[],
        detected_dns_provider: detectedProvider,
      },
    });

    res.status(201).json(serializeDomain(created));
  } catch (err) {
    logger.error('createEmailDomain error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getEmailDomain(req: Request, res: Response) {
  try {
    const row = await prisma.organizationDomain.findUnique({ where: tenantWhere(req) });
    if (!row) {
      res.status(404).json({ error: 'No sending domain configured for this organization.' });
      return;
    }
    const domainRow = row;

    if (!resend) {
      res.json(serializeDomain(domainRow));
      return;
    }

    let liveData: { status: string; records: unknown } | null = null;
    try {
      const { data, error } = await resend.domains.get(domainRow.resend_domain_id);
      if (error || !data) {
        logger.warn(
          `getEmailDomain: Resend get() failed for organization ${req.user!.organization_id}, serving last-known status: ${error?.message}`,
        );
      } else {
        liveData = { status: data.status, records: data.records };
      }
    } catch (err) {
      logger.warn(`getEmailDomain: Resend get() threw for organization ${req.user!.organization_id}, serving last-known status:`, err);
    }

    if (!liveData) {
      res.json(serializeDomain(domainRow));
      return;
    }

    const { row: updated, justVerified } = await applyFreshDomainStatus(prisma, domainRow, liveData);
    if (justVerified) {
      await notifyDomainVerified(updated).catch((err) =>
        logger.error(`Failed to send domain-verified notification for organization ${updated.organization_id}:`, err));
    }
    res.json(serializeDomain(updated));
  } catch (err) {
    logger.error('getEmailDomain error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function verifyEmailDomain(req: Request, res: Response) {
  try {
    const row = await prisma.organizationDomain.findUnique({ where: tenantWhere(req) });
    if (!row) {
      res.status(404).json({ error: 'No sending domain configured for this organization.' });
      return;
    }
    const domainRow = row;

    if (!resend) {
      res.status(502).json({ error: 'Email provider is not configured' });
      return;
    }

    const { error: verifyError } = await resend.domains.verify(domainRow.resend_domain_id);
    if (verifyError) {
      res.status(502).json({ error: verifyError.message ?? 'Failed to trigger domain verification' });
      return;
    }

    // resend.domains.verify() only echoes back {id} — pull the resulting status.
    const { data, error: getError } = await resend.domains.get(domainRow.resend_domain_id);
    if (getError || !data) {
      logger.warn(
        `verifyEmailDomain: Resend get() after verify() failed for organization ${req.user!.organization_id}: ${getError?.message}`,
      );
      res.json(serializeDomain(domainRow));
      return;
    }

    const { row: updated, justVerified } = await applyFreshDomainStatus(prisma, domainRow, {
      status: data.status,
      records: data.records,
    });
    if (justVerified) {
      await notifyDomainVerified(updated).catch((err) =>
        logger.error(`Failed to send domain-verified notification for organization ${updated.organization_id}:`, err));
    }
    res.json(serializeDomain(updated));
  } catch (err) {
    logger.error('verifyEmailDomain error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteEmailDomain(req: Request, res: Response) {
  try {
    const row = await prisma.organizationDomain.findUnique({ where: tenantWhere(req) });
    if (!row) {
      res.status(404).json({ error: 'No sending domain configured for this organization.' });
      return;
    }
    const domainRow = row;

    if (resend) {
      const { error } = await resend.domains.remove(domainRow.resend_domain_id);
      if (error) {
        res.status(502).json({ error: error.message ?? 'Failed to remove the domain from the email provider' });
        return;
      }
    } else {
      logger.warn(
        `deleteEmailDomain: RESEND_API_KEY not configured — deleting the local row for organization ${req.user!.organization_id} without calling Resend`,
      );
    }

    await prisma.organizationDomain.delete({ where: { id: domainRow.id } });
    res.json({ deleted: true });
  } catch (err) {
    logger.error('deleteEmailDomain error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

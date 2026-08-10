import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// Never make real network calls in tests — mock Node's dns module outright.
const { resolveNs } = vi.hoisted(() => ({ resolveNs: vi.fn() }));
vi.mock('dns', () => ({
  promises: { resolveNs },
  default: { promises: { resolveNs } },
}));

import { isPlausibleDomainName, apexDomainOf, detectDnsProvider, UNIDENTIFIED_DNS_PROVIDER } from '../lib/dns-provider';

describe('isPlausibleDomainName', () => {
  it('accepts a simple apex domain', () => {
    expect(isPlausibleDomainName('acme.com')).toBe(true);
  });

  it('accepts a subdomain', () => {
    expect(isPlausibleDomainName('mail.acme-plumbing.com')).toBe(true);
  });

  it('accepts a multi-level subdomain', () => {
    expect(isPlausibleDomainName('a.b.c.example.co')).toBe(true);
  });

  it('rejects a bare label with no dot', () => {
    expect(isPlausibleDomainName('localhost')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isPlausibleDomainName('')).toBe(false);
  });

  it('rejects a domain with a leading hyphen in a label', () => {
    expect(isPlausibleDomainName('-acme.com')).toBe(false);
  });

  it('rejects a domain with a trailing hyphen in a label', () => {
    expect(isPlausibleDomainName('acme-.com')).toBe(false);
  });

  it('rejects a domain containing spaces', () => {
    expect(isPlausibleDomainName('acme plumbing.com')).toBe(false);
  });

  it('rejects a domain containing an @ (an email address, not a domain)', () => {
    expect(isPlausibleDomainName('user@acme.com')).toBe(false);
  });

  it('rejects a scheme-prefixed value', () => {
    expect(isPlausibleDomainName('https://acme.com')).toBe(false);
  });
});

describe('apexDomainOf', () => {
  it('returns the domain unchanged when it is already an apex', () => {
    expect(apexDomainOf('acme.com')).toBe('acme.com');
  });

  it('strips a single subdomain label', () => {
    expect(apexDomainOf('mail.acme.com')).toBe('acme.com');
  });

  it('strips multiple subdomain labels down to the last two', () => {
    expect(apexDomainOf('a.b.mail.acme.com')).toBe('acme.com');
  });
});

describe('detectDnsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies Cloudflare nameservers', async () => {
    (resolveNs as Mock).mockResolvedValue(['ana.ns.cloudflare.com', 'bob.ns.cloudflare.com']);
    expect(await detectDnsProvider('acme.com')).toBe('Cloudflare');
  });

  it('identifies GoDaddy nameservers', async () => {
    (resolveNs as Mock).mockResolvedValue(['ns17.domaincontrol.com', 'ns18.domaincontrol.com']);
    expect(await detectDnsProvider('acme.com')).toBe('GoDaddy');
  });

  it('identifies Namecheap nameservers', async () => {
    (resolveNs as Mock).mockResolvedValue(['dns1.registrar-servers.com', 'dns2.registrar-servers.com']);
    expect(await detectDnsProvider('acme.com')).toBe('Namecheap');
  });

  it('identifies Google Domains nameservers', async () => {
    (resolveNs as Mock).mockResolvedValue(['ns-cloud-a1.googledomains.com', 'ns-cloud-a2.googledomains.com']);
    expect(await detectDnsProvider('acme.com')).toBe('Google Domains');
  });

  it('identifies Amazon Route 53 nameservers', async () => {
    (resolveNs as Mock).mockResolvedValue(['ns-1234.awsdns-12.com', 'ns-567.awsdns-34.co.uk']);
    expect(await detectDnsProvider('acme.com')).toBe('Amazon Route 53');
  });

  it('returns Unidentified for a nameserver pattern not in the fingerprint table', async () => {
    (resolveNs as Mock).mockResolvedValue(['ns1.some-random-host.example']);
    expect(await detectDnsProvider('acme.com')).toBe(UNIDENTIFIED_DNS_PROVIDER);
  });

  it('returns Unidentified (never throws) when resolveNs rejects', async () => {
    (resolveNs as Mock).mockRejectedValue(new Error('ENOTFOUND'));
    await expect(detectDnsProvider('acme.com')).resolves.toBe(UNIDENTIFIED_DNS_PROVIDER);
  });

  it('returns Unidentified when resolveNs resolves an empty list', async () => {
    (resolveNs as Mock).mockResolvedValue([]);
    expect(await detectDnsProvider('acme.com')).toBe(UNIDENTIFIED_DNS_PROVIDER);
  });
});

import dns from 'dns';

/**
 * Email slice 10 (guided domain verification) — the ONLY DNS-provider
 * detection this feature has. Resend's SDK has no nameserver-detection field
 * on the real Domain/GetDomainResponse type despite a `DomainNameservers`
 * type existing in it (checked against node_modules/resend/dist/index.d.mts —
 * it is not attached to any real response field in this SDK version), so this
 * is our own best-effort `dns.promises.resolveNs()` lookup matched against a
 * small, deliberately extensible fingerprint table.
 *
 * "Never ask who hosts your domain" is the bar to clear, not perfect
 * detection — an unmatched or failed lookup falls back to 'Unidentified'
 * rather than throwing or blocking the create flow.
 */

/** Syntactically plausible domain name: at least two dot-separated labels,
 * each 1-63 chars, alphanumeric + interior hyphens only (no leading/trailing
 * hyphen), total length <= 253. Deliberately does not validate the TLD
 * against a real public-suffix list — Resend itself is the final authority on
 * whether a submitted domain is actually usable. */
const DOMAIN_REGEX = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export function isPlausibleDomainName(value: string): boolean {
  return value.length > 0 && value.length <= 253 && DOMAIN_REGEX.test(value);
}

/**
 * The registrable/apex domain, best-effort: the last two dot-separated
 * labels. Nameservers are looked up at the apex, not at whatever subdomain the
 * org wants to send from (a subdomain like mail.acme.com does not carry its
 * own NS records unless specifically delegated).
 *
 * KNOWN LIMITATION: this is a naive "last two labels" heuristic, not a real
 * public-suffix-list lookup, so it mis-derives the apex for multi-part TLDs
 * (e.g. 'mail.acme.co.uk' -> 'co.uk', not 'acme.co.uk'). Acceptable for this
 * best-effort feature — a wrong apex just means detectDnsProvider looks up
 * the wrong NS records and reports 'Unidentified', never a hard failure.
 */
export function apexDomainOf(domain: string): string {
  const labels = domain.split('.');
  return labels.slice(-2).join('.');
}

interface DnsProviderFingerprint {
  provider: string;
  pattern: RegExp;
}

// Small and deliberately extensible — add a new { provider, pattern } entry
// for any other registrar/DNS host worth recognizing.
const DNS_PROVIDER_FINGERPRINTS: readonly DnsProviderFingerprint[] = [
  { provider: 'Cloudflare', pattern: /\.ns\.cloudflare\.com$/i },
  { provider: 'GoDaddy', pattern: /\.domaincontrol\.com$/i },
  { provider: 'Namecheap', pattern: /\.registrar-servers\.com$/i },
  { provider: 'Google Domains', pattern: /\.(googledomains\.com|domains\.google)$/i },
  { provider: 'Amazon Route 53', pattern: /\.awsdns-\d+\.(com|net|org|co\.uk)$/i },
];

export const UNIDENTIFIED_DNS_PROVIDER = 'Unidentified';

/**
 * Best-effort DNS-provider guess for `apexDomain`, via a live NS lookup
 * matched against DNS_PROVIDER_FINGERPRINTS. NEVER throws — any lookup
 * failure (NXDOMAIN, network error, timeout) or an unmatched nameserver
 * pattern resolves to UNIDENTIFIED_DNS_PROVIDER rather than blocking the
 * caller (domain creation must succeed even when this can't identify anything).
 */
export async function detectDnsProvider(apexDomain: string): Promise<string> {
  try {
    const nameservers = await dns.promises.resolveNs(apexDomain);
    for (const ns of nameservers) {
      const match = DNS_PROVIDER_FINGERPRINTS.find((f) => f.pattern.test(ns));
      if (match) return match.provider;
    }
    return UNIDENTIFIED_DNS_PROVIDER;
  } catch {
    return UNIDENTIFIED_DNS_PROVIDER;
  }
}

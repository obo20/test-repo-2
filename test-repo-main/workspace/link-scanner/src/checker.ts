import axios from 'axios';

export type LinkStatus = 'healthy' | 'broken' | 'takeover_risk' | 'unclear';

export interface CheckResult {
  url: string;
  status: LinkStatus;
  httpStatus?: number;
  reason?: string;
}

// ── Subdomain takeover signatures ─────────────────────────────────────────────
// These patterns appear in the response body of platforms when a subdomain
// points to a service that no longer exists — a classic takeover vector.

const TAKEOVER_SIGNATURES: { pattern: RegExp; platform: string }[] = [
  { pattern: /There isn't a GitHub Pages site here/i,            platform: 'GitHub Pages' },
  { pattern: /No such app/i,                                      platform: 'Heroku' },
  { pattern: /Fastly error: unknown domain/i,                     platform: 'Fastly CDN' },
  { pattern: /404 Web Site not found/i,                           platform: 'Azure' },
  { pattern: /NoSuchBucket/i,                                     platform: 'AWS S3' },
  { pattern: /The specified bucket does not exist/i,              platform: 'AWS S3' },
  { pattern: /project not found/i,                                platform: 'Surge.sh' },
  { pattern: /Repository not found/i,                             platform: 'Bitbucket' },
  { pattern: /This UserVoice subdomain is currently available/i,  platform: 'UserVoice' },
  { pattern: /Do you want to register/i,                          platform: 'WordPress.com' },
  { pattern: /is not registered with Netlify/i,                   platform: 'Netlify' },
  { pattern: /Unrecognized domain/i,                              platform: 'Shopify' },
  { pattern: /Sorry, we couldn't find that page/i,               platform: 'Tumblr' },
  { pattern: /Help Center Closed/i,                               platform: 'Zendesk' },
  { pattern: /This shop is currently unavailable/i,               platform: 'Shopify' },
  { pattern: /The feed has not been found\./i,                    platform: 'Feedpress' },
  { pattern: /Ghost blog not found/i,                             platform: 'Ghost.io' },
  { pattern: /The thing you were looking for is no longer here/i, platform: 'Tumblr' },
  { pattern: /page not found.*pantheon/i,                         platform: 'Pantheon' },
];

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; LinkScanner/1.0)',
};

// ── Bot-blocking domains ───────────────────────────────────────────────────────
// These platforms reliably return 403/401 to automated requests even for
// perfectly valid URLs. Skip HTTP checks for them entirely.

const BOT_BLOCKED_DOMAINS = [
  'twitter.com',
  'x.com',
  'instagram.com',
  'facebook.com',
  'fb.com',
  'linkedin.com',
  'tiktok.com',
];

async function fetchGet(url: string): Promise<{ status: number; body: string }> {
  const response = await axios.get<string>(url, {
    timeout: 12_000,
    maxRedirects: 5,
    headers: REQUEST_HEADERS,
    validateStatus: () => true, // never throw on HTTP errors
    responseType: 'text',
  });
  return { status: response.status, body: response.data ?? '' };
}

function checkTakeover(body: string): string | null {
  for (const { pattern, platform } of TAKEOVER_SIGNATURES) {
    if (pattern.test(body)) return platform;
  }
  return null;
}

export async function checkLink(url: string): Promise<CheckResult> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { url, status: 'unclear', reason: 'Non-HTTP URL — skipped' };
  }

  // Skip known bot-blocking platforms — they return 403 to all automated
  // requests regardless of whether the link is valid.
  try {
    const { hostname } = new URL(url);
    const bare = hostname.replace(/^www\./, '');
    if (BOT_BLOCKED_DOMAINS.some((d) => bare === d || bare.endsWith('.' + d))) {
      return { url, status: 'healthy', reason: 'Skipped — bot-blocking domain' };
    }
  } catch {
    // Malformed URL — fall through to normal check
  }

  try {
    // Try HEAD first (fast, no body)
    let httpStatus: number;
    let body: string | undefined;

    try {
      const headRes = await axios.head(url, {
        timeout: 10_000,
        maxRedirects: 5,
        headers: REQUEST_HEADERS,
        validateStatus: () => true,
      });
      httpStatus = headRes.status;
    } catch {
      // HEAD not supported by server — fall through to GET
      httpStatus = 0;
    }

    // For potential takeover candidates, when HEAD failed, or when the server
    // doesn't support HEAD (405 Method Not Allowed) — fall back to GET.
    if (httpStatus === 0 || httpStatus === 404 || httpStatus === 405 || httpStatus >= 500) {
      const result = await fetchGet(url);
      httpStatus = result.status;
      body = result.body;
    }

    // Takeover signature check
    if (body) {
      const platform = checkTakeover(body);
      if (platform) {
        return {
          url,
          status: 'takeover_risk',
          httpStatus,
          reason: `Subdomain takeover risk: ${platform} signature detected in response`,
        };
      }
    }

    if (httpStatus >= 200 && httpStatus < 400) {
      return { url, status: 'healthy', httpStatus };
    }

    if (httpStatus === 403 || httpStatus === 401) {
      return { url, status: 'healthy', httpStatus };
    }

    if (httpStatus >= 400) {
      return {
        url,
        status: 'broken',
        httpStatus,
        reason: `HTTP ${httpStatus}`,
      };
    }

    return { url, status: 'unclear', httpStatus, reason: 'Unexpected status code' };

  } catch (err: unknown) {
    const error = err as { code?: string; message?: string };
    const code = error?.code ?? '';
    const message = error?.message ?? 'Unknown error';

    // DNS failure on a subdomain → CNAME takeover risk
    if (code === 'ENOTFOUND') {
      try {
        const { hostname } = new URL(url);
        const parts = hostname.split('.');
        if (parts.length > 2) {
          return {
            url,
            status: 'takeover_risk',
            reason: `DNS NXDOMAIN on subdomain "${hostname}" — potential CNAME/dangling subdomain takeover`,
          };
        }
      } catch {
        // Malformed URL — ignore
      }
      return { url, status: 'broken', reason: `DNS resolution failed` };
    }

    if (code === 'ECONNREFUSED') {
      return { url, status: 'broken', reason: 'Connection refused' };
    }

    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || message.includes('timeout')) {
      return { url, status: 'unclear', reason: 'Request timed out' };
    }

    if (
      code === 'CERT_HAS_EXPIRED' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      message.includes('certificate') ||
      message.includes('SSL')
    ) {
      return { url, status: 'broken', reason: `TLS/SSL error: ${message}` };
    }

    return { url, status: 'unclear', reason: message };
  }
}

import type { Platform } from '../concierge-client-types.js';

export interface ParsedUrl {
  platform: Platform;
  listingId?: string;
  url: string;
}

const PLATFORM_PATTERNS: Record<Platform, RegExp[]> = {
  airbnb: [
    /airbnb\.(com|[a-z]{2}|co\.[a-z]{2})\/rooms\/(\d+)/i,
    /airbnb\.(com|[a-z]{2}|co\.[a-z]{2})\/h\/([a-zA-Z0-9-]+)/i,
  ],
  booking: [/booking\.com\/hotel\/[a-z]{2}\/([^/?]+)/i, /booking\.com\/[a-z]{2}\/hotel\/[a-z]{2}\/([^/?]+)/i],
  vrbo: [/vrbo\.com\/(\d+)/i, /vrbo\.com\/[a-z]{2}\/vacation-rentals\/[^/]+\/(\d+)/i],
  expedia: [
    /expedia\.(com|[a-z]{2}|co\.[a-z]{2})\/[^/]*[Hh]otel[^/]*\/([^/?]+)/i,
    /expedia\.(com|[a-z]{2}|co\.[a-z]{2})\/[^/]+\.h(\d+)\./i,
  ],
  'google-places': [],
  unknown: [],
};

export function parseListingUrl(url: string): ParsedUrl {
  // Normalize URL
  let normalizedUrl = url.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = `https://${normalizedUrl}`;
  }

  // Try to parse as URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return { platform: 'unknown', url: normalizedUrl };
  }

  // Detect platform
  for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
    if (platform === 'unknown') continue;

    for (const pattern of patterns) {
      const match = normalizedUrl.match(pattern);
      if (match) {
        return {
          platform: platform as Platform,
          listingId: match[2] || match[1],
          url: normalizedUrl,
        };
      }
    }
  }

  // Try to detect by hostname alone
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname.includes('airbnb')) {
    return { platform: 'airbnb', url: normalizedUrl };
  }
  if (hostname.includes('booking.com')) {
    return { platform: 'booking', url: normalizedUrl };
  }
  if (hostname.includes('vrbo')) {
    return { platform: 'vrbo', url: normalizedUrl };
  }
  if (hostname.includes('expedia')) {
    return { platform: 'expedia', url: normalizedUrl };
  }

  return { platform: 'unknown', url: normalizedUrl };
}

export function isValidUrl(url: string): boolean {
  try {
    new URL(url.startsWith('http') ? url : `https://${url}`);
    return true;
  } catch {
    return false;
  }
}

export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname;
  } catch {
    return null;
  }
}

export function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    // Remove tracking parameters
    const cleanParams = new URLSearchParams();
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_content',
      'utm_term',
      'ref',
      'affiliate_id',
    ];

    parsed.searchParams.forEach((value, key) => {
      if (!trackingParams.includes(key.toLowerCase())) {
        cleanParams.set(key, value);
      }
    });

    parsed.search = cleanParams.toString();
    return parsed.toString();
  } catch {
    return url;
  }
}

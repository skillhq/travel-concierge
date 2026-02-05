import type {
  ConciergeConfig,
  ContactDossier,
  ContactInfo,
  FetchOptions,
  PropertyInfo,
  Result,
  SourceInfo,
} from './concierge-client-types.js';
import { loadConfig } from './config.js';
import { extractContacts } from './utils/contact-extractor.js';
import { cleanPropertyName, emptyContacts, formatGoogleMapsUrl, mergeContacts } from './utils/formatters.js';
import { parseListingUrl } from './utils/url-parser.js';

export interface FindContactOptions {
  html?: string;
  verbose?: boolean;
}

interface PlacesSearchResponse {
  candidates?: Array<{
    place_id: string;
    name: string;
    formatted_address?: string;
    geometry?: {
      location: { lat: number; lng: number };
    };
  }>;
  status: string;
  error_message?: string;
}

interface PlaceDetailsResponse {
  result?: {
    name: string;
    formatted_phone_number?: string;
    international_phone_number?: string;
    website?: string;
    url?: string;
    formatted_address?: string;
  };
  status: string;
  error_message?: string;
}

export class ConciergeClient {
  private config: ConciergeConfig;

  constructor(config?: Partial<ConciergeConfig>) {
    const loadedConfig = loadConfig();
    this.config = { ...loadedConfig, ...config };
  }

  private get timeout(): number {
    return this.config.timeoutMs ?? 30000;
  }

  private async fetchWithTimeout(url: string, options: FetchOptions = {}): Promise<Result<string>> {
    const controller = new AbortController();
    const timeout = options.timeout ?? this.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          ...options.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const html = await response.text();
      return { success: true, data: html };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return { success: false, error: `Request timed out after ${timeout}ms` };
        }
        return { success: false, error: error.message };
      }
      return { success: false, error: 'Unknown fetch error' };
    }
  }

  private async fetchJson<T>(url: string, options: FetchOptions = {}): Promise<Result<T>> {
    const controller = new AbortController();
    const timeout = options.timeout ?? this.timeout;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...options.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const json = (await response.json()) as T;
      return { success: true, data: json };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return { success: false, error: `Request timed out after ${timeout}ms` };
        }
        return { success: false, error: error.message };
      }
      return { success: false, error: 'Unknown fetch error' };
    }
  }

  private log(message: string, verbose: boolean): void {
    if (verbose) {
      console.log(`[concierge] ${message}`);
    }
  }

  async findContacts(url: string, options: FindContactOptions = {}): Promise<Result<ContactDossier>> {
    const { html, verbose = false } = options;

    // Step 1: Parse URL to detect platform
    const parsed = parseListingUrl(url);
    this.log(`Detected platform: ${parsed.platform}`, verbose);

    // Step 2: Extract property info from listing
    let property: PropertyInfo;

    switch (parsed.platform) {
      case 'airbnb':
        property = this.parseAirbnbHtml(html || '', parsed.url);
        break;
      case 'booking':
        property = this.parseBookingHtml(html || '', parsed.url);
        break;
      case 'vrbo':
        property = this.parseVrboHtml(html || '', parsed.url);
        break;
      case 'expedia':
        property = this.parseExpediaHtml(html || '', parsed.url);
        break;
      default:
        return {
          success: false,
          error: 'Unsupported platform. Supported: Airbnb, Booking.com, VRBO, Expedia',
        };
    }

    this.log(`Property: ${property.name}`, verbose);
    this.log(`Location: ${this.formatLocation(property.location)}`, verbose);

    // Step 3: Collect contact information from various sources
    let contacts = emptyContacts();
    const sources: SourceInfo[] = [];

    // Add listing as a source
    sources.push({
      type: 'listing',
      url: property.listingUrl,
      confidence: 'high',
    });

    // Step 3a: Try Google Places API if configured
    if (this.config.googlePlacesApiKey) {
      this.log('Searching Google Places...', verbose);

      const searchQuery = this.buildSearchQuery(property);
      const placesResult = await this.searchGooglePlaces(searchQuery);

      if (placesResult.success) {
        contacts = mergeContacts(contacts, placesResult.data.contacts);
        sources.push(...placesResult.data.sources);
        this.log(`Found via Google Places: ${JSON.stringify(placesResult.data.contacts)}`, verbose);
      } else {
        this.log(`Google Places search failed: ${placesResult.error}`, verbose);
      }
    }

    // Step 3b: If we have a website, scrape it for contacts
    if (contacts.website) {
      this.log(`Scraping website: ${contacts.website}`, verbose);

      const websiteResult = await this.scrapeContactPage(contacts.website);
      if (websiteResult.success) {
        contacts = mergeContacts(contacts, websiteResult.data.contacts);
        sources.push(...websiteResult.data.sources);
        this.log(`Found via website: ${JSON.stringify(websiteResult.data.contacts)}`, verbose);
      }
    }

    // Step 3c: If we found an Instagram handle, look it up
    if (contacts.instagram) {
      this.log(`Looking up Instagram: ${contacts.instagram}`, verbose);

      const igResult = await this.lookupInstagramProfile(contacts.instagram);
      if (igResult.success) {
        // Only merge new info, keep the handle
        const igContacts = igResult.data.contacts as ContactInfo;
        if (igContacts.website && !contacts.website) {
          contacts.website = igContacts.website;
        }
        if (igContacts.email?.length) {
          contacts.email = [...new Set([...(contacts.email || []), ...igContacts.email])];
        }
        if (igContacts.phone?.length) {
          contacts.phone = [...new Set([...(contacts.phone || []), ...igContacts.phone])];
        }
        sources.push(...igResult.data.sources);
      }
    }

    // Build the dossier
    const dossier: ContactDossier = {
      property,
      contacts,
      sources: this.deduplicateSources(sources),
      searchedAt: new Date().toISOString(),
    };

    return { success: true, data: dossier };
  }

  // Platform parsers
  private parseAirbnbHtml(html: string, url: string): PropertyInfo {
    const property: PropertyInfo = {
      platform: 'airbnb',
      name: 'Airbnb Listing',
      location: {},
      listingUrl: url,
    };

    const idMatch = url.match(/\/rooms\/(\d+)/);
    if (idMatch) {
      property.name = `Airbnb Listing #${idMatch[1]}`;
    }

    if (!html) return property;

    // Extract from og:title
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitleMatch) {
      const title = ogTitleMatch[1].trim();
      if (title && title.length < 200) {
        property.name = cleanPropertyName(title);
      }
    }

    // Extract JSON-LD
    this.parseJsonLd(html, property);

    // Extract host
    const hostMatch = html.match(/Hosted by ([^<"\n]+)/i);
    if (hostMatch) {
      property.hostName = hostMatch[1].trim();
    }

    return property;
  }

  private parseBookingHtml(html: string, url: string): PropertyInfo {
    const property: PropertyInfo = {
      platform: 'booking',
      name: 'Booking.com Listing',
      location: {},
      listingUrl: url,
    };

    const urlMatch = url.match(/\/hotel\/[a-z]{2}\/([^/?]+)/i);
    if (urlMatch) {
      property.name = urlMatch[1]
        .replace(/\.html?$/i, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
    }

    if (!html) return property;

    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitleMatch) {
      const title = ogTitleMatch[1].replace(/\s*[-·|]\s*Booking\.com.*$/i, '').trim();
      if (title && title.length < 200) {
        property.name = cleanPropertyName(title);
      }
    }

    this.parseJsonLd(html, property);

    return property;
  }

  private parseVrboHtml(html: string, url: string): PropertyInfo {
    const property: PropertyInfo = {
      platform: 'vrbo',
      name: 'VRBO Listing',
      location: {},
      listingUrl: url,
    };

    const idMatch = url.match(/vrbo\.com\/(\d+)/i);
    if (idMatch) {
      property.name = `VRBO Listing #${idMatch[1]}`;
    }

    if (!html) return property;

    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitleMatch) {
      const title = ogTitleMatch[1].trim();
      if (title && title.length < 200) {
        property.name = cleanPropertyName(title);
      }
    }

    this.parseJsonLd(html, property);

    const hostMatch = html.match(/Hosted by ([^<"\n]+)/i);
    if (hostMatch) {
      property.hostName = hostMatch[1].trim();
    }

    return property;
  }

  private parseExpediaHtml(html: string, url: string): PropertyInfo {
    const property: PropertyInfo = {
      platform: 'expedia',
      name: 'Expedia Listing',
      location: {},
      listingUrl: url,
    };

    const slugMatch = url.match(/\/([^/]+)\.h\d+\./i);
    if (slugMatch) {
      property.name = slugMatch[1]
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
    }

    if (!html) return property;

    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitleMatch) {
      const title = ogTitleMatch[1].replace(/\s*[-·|]\s*Expedia.*$/i, '').trim();
      if (title && title.length < 200) {
        property.name = cleanPropertyName(title);
      }
    }

    this.parseJsonLd(html, property);

    return property;
  }

  private parseJsonLd(html: string, property: PropertyInfo): void {
    const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (!jsonLdMatch) return;

    for (const match of jsonLdMatch) {
      const jsonContent = match.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
      try {
        const data = JSON.parse(jsonContent);
        if (data.name) {
          property.name = cleanPropertyName(data.name);
        }
        if (data.address) {
          if (typeof data.address === 'string') {
            property.location.address = data.address;
          } else {
            property.location.city = data.address.addressLocality;
            property.location.region = data.address.addressRegion;
            property.location.country = data.address.addressCountry?.name || data.address.addressCountry;
          }
        }
        if (data.geo) {
          property.location.coordinates = {
            lat: Number.parseFloat(data.geo.latitude),
            lng: Number.parseFloat(data.geo.longitude),
          };
        }
      } catch {
        // JSON parse failed, continue
      }
    }
  }

  // Contact discovery methods
  private async searchGooglePlaces(
    query: string,
  ): Promise<Result<{ contacts: Partial<ContactInfo>; sources: SourceInfo[] }>> {
    const apiKey = this.config.googlePlacesApiKey;
    if (!apiKey) {
      return { success: false, error: 'Google Places API key not configured' };
    }

    try {
      const searchUrl = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
      searchUrl.searchParams.set('input', query);
      searchUrl.searchParams.set('inputtype', 'textquery');
      searchUrl.searchParams.set('fields', 'place_id,name,formatted_address,geometry');
      searchUrl.searchParams.set('key', apiKey);

      const searchResult = await this.fetchJson<PlacesSearchResponse>(searchUrl.toString());
      if (!searchResult.success) return searchResult;

      if (searchResult.data.status !== 'OK' || !searchResult.data.candidates?.length) {
        return { success: false, error: searchResult.data.error_message || 'No places found' };
      }

      const place = searchResult.data.candidates[0];

      const detailsUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
      detailsUrl.searchParams.set('place_id', place.place_id);
      detailsUrl.searchParams.set('fields', 'name,formatted_phone_number,international_phone_number,website,url');
      detailsUrl.searchParams.set('key', apiKey);

      const detailsResult = await this.fetchJson<PlaceDetailsResponse>(detailsUrl.toString());
      if (!detailsResult.success) return detailsResult;

      if (detailsResult.data.status !== 'OK' || !detailsResult.data.result) {
        return { success: false, error: detailsResult.data.error_message || 'Failed to get place details' };
      }

      const details = detailsResult.data.result;
      const contacts: Partial<ContactInfo> = { phone: [], email: [] };

      const phone = details.international_phone_number || details.formatted_phone_number;
      if (phone) contacts.phone = [phone];
      if (details.website) contacts.website = details.website;
      if (details.url) {
        contacts.googleMapsUrl = details.url;
      } else if (place.geometry?.location) {
        contacts.googleMapsUrl = formatGoogleMapsUrl(`${place.geometry.location.lat},${place.geometry.location.lng}`);
      }

      return {
        success: true,
        data: {
          contacts,
          sources: [
            {
              type: 'google-places',
              url: contacts.googleMapsUrl,
              confidence: 'high',
              note: `Matched: ${details.name}`,
            },
          ],
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Google Places API error' };
    }
  }

  private async scrapeWebsiteContacts(
    url: string,
  ): Promise<Result<{ contacts: Partial<ContactInfo>; sources: SourceInfo[] }>> {
    const htmlResult = await this.fetchWithTimeout(url);
    if (!htmlResult.success) return htmlResult;

    const extracted = extractContacts(htmlResult.data);
    const contacts: Partial<ContactInfo> = {
      phone: extracted.phones,
      email: extracted.emails,
      whatsapp: extracted.whatsapp[0],
      instagram: extracted.instagram[0],
      facebook: extracted.facebook[0],
    };

    const sources: SourceInfo[] = [];
    if (extracted.emails.length > 0 || extracted.phones.length > 0) {
      sources.push({ type: 'website', url, confidence: 'medium' });
    }

    return { success: true, data: { contacts, sources } };
  }

  private async scrapeContactPage(
    baseUrl: string,
  ): Promise<Result<{ contacts: Partial<ContactInfo>; sources: SourceInfo[] }>> {
    const contactPaths = ['/contact', '/contact-us', '/contacto', '/about'];
    let baseUrlParsed: URL;

    try {
      baseUrlParsed = new URL(baseUrl);
    } catch {
      return { success: false, error: 'Invalid base URL' };
    }

    const allContacts: Partial<ContactInfo> = { phone: [], email: [] };
    const allSources: SourceInfo[] = [];

    // Scrape main page first
    const mainResult = await this.scrapeWebsiteContacts(baseUrl);
    if (mainResult.success) {
      this.mergePartialContacts(allContacts, mainResult.data.contacts);
      allSources.push(...mainResult.data.sources);
    }

    // Try contact pages
    for (const path of contactPaths) {
      const contactUrl = new URL(path, baseUrlParsed).toString();
      const result = await this.scrapeWebsiteContacts(contactUrl);

      if (result.success && this.hasAnyPartialContact(result.data.contacts)) {
        this.mergePartialContacts(allContacts, result.data.contacts);
        for (const source of result.data.sources) {
          if (source.type === 'website') {
            source.url = contactUrl;
            source.note = 'Contact page';
          }
          allSources.push(source);
        }

        if ((allContacts.email?.length ?? 0) > 0 && (allContacts.phone?.length ?? 0) > 0) {
          break;
        }
      }
    }

    if (allContacts.phone) allContacts.phone = [...new Set(allContacts.phone)];
    if (allContacts.email) allContacts.email = [...new Set(allContacts.email)];

    return { success: true, data: { contacts: allContacts, sources: this.deduplicateSources(allSources) } };
  }

  private async lookupInstagramProfile(
    handle: string,
  ): Promise<Result<{ contacts: Partial<ContactInfo>; sources: SourceInfo[] }>> {
    const cleanHandle = handle.replace(/^@/, '').toLowerCase();
    const profileUrl = `https://www.instagram.com/${cleanHandle}/`;

    const htmlResult = await this.fetchWithTimeout(profileUrl);
    if (!htmlResult.success) {
      return {
        success: true,
        data: {
          contacts: { instagram: `@${cleanHandle}` },
          sources: [
            {
              type: 'instagram',
              url: profileUrl,
              confidence: 'low',
              note: 'Profile exists but details require browser access',
            },
          ],
        },
      };
    }

    const html = htmlResult.data;
    const contacts: Partial<ContactInfo> = { instagram: `@${cleanHandle}` };
    const extracted = extractContacts(html);

    if (extracted.emails.length > 0) contacts.email = extracted.emails;
    if (extracted.phones.length > 0) contacts.phone = extracted.phones;

    const websiteMatch = html.match(/"external_url"\s*:\s*"([^"]+)"/i);
    if (websiteMatch) {
      let website = websiteMatch[1];
      website = website.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
      if (website && !website.includes('instagram.com')) {
        contacts.website = website;
      }
    }

    return {
      success: true,
      data: {
        contacts,
        sources: [
          {
            type: 'instagram',
            url: profileUrl,
            confidence: contacts.email || contacts.phone ? 'medium' : 'low',
          },
        ],
      },
    };
  }

  // Helper methods
  private formatLocation(location: PropertyInfo['location']): string {
    return [location.city, location.region, location.country].filter(Boolean).join(', ') || 'Unknown';
  }

  private buildSearchQuery(property: PropertyInfo): string {
    const parts = [property.name];
    if (property.location.city) parts.push(property.location.city);
    if (property.location.country) parts.push(property.location.country);
    parts.push(property.platform === 'airbnb' || property.platform === 'vrbo' ? 'vacation rental' : 'hotel');
    return parts.join(' ');
  }

  private mergePartialContacts(target: Partial<ContactInfo>, source: Partial<ContactInfo>): void {
    if (source.phone) target.phone = [...(target.phone || []), ...source.phone];
    if (source.email) target.email = [...(target.email || []), ...source.email];
    if (source.whatsapp && !target.whatsapp) target.whatsapp = source.whatsapp;
    if (source.instagram && !target.instagram) target.instagram = source.instagram;
    if (source.facebook && !target.facebook) target.facebook = source.facebook;
    if (source.website && !target.website) target.website = source.website;
  }

  private hasAnyPartialContact(contacts: Partial<ContactInfo>): boolean {
    return (
      (contacts.phone?.length ?? 0) > 0 ||
      (contacts.email?.length ?? 0) > 0 ||
      !!contacts.whatsapp ||
      !!contacts.instagram ||
      !!contacts.facebook
    );
  }

  private deduplicateSources(sources: SourceInfo[]): SourceInfo[] {
    const seen = new Set<string>();
    return sources.filter((source) => {
      const key = `${source.type}-${source.url || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

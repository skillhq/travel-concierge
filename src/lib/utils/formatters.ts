import type { ContactInfo, Platform } from '../concierge-client-types.js';

export function formatPlatformName(platform: Platform): string {
  const names: Record<Platform, string> = {
    airbnb: 'Airbnb',
    booking: 'Booking.com',
    vrbo: 'VRBO',
    expedia: 'Expedia',
    'google-places': 'Google Places',
    unknown: 'Unknown',
  };
  return names[platform];
}

export function formatPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  // Already has country code
  if (phone.startsWith('+')) {
    return phone;
  }

  // US/Canada format
  if (digits.length === 10) {
    return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  // International format with country code
  if (digits.length > 10) {
    return `+${digits}`;
  }

  return phone;
}

export function formatInstagramHandle(handle: string): string {
  const clean = handle.replace(/^@/, '').toLowerCase();
  return `@${clean}`;
}

export function formatInstagramUrl(handle: string): string {
  const clean = handle.replace(/^@/, '').toLowerCase();
  return `https://instagram.com/${clean}`;
}

export function formatFacebookUrl(page: string): string {
  if (page.startsWith('http')) {
    return page;
  }
  return `https://facebook.com/${page}`;
}

export function formatWhatsAppUrl(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}`;
}

export function formatGoogleMapsUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function mergeContacts(a: ContactInfo, b: Partial<ContactInfo>): ContactInfo {
  return {
    phone: [...new Set([...(a.phone || []), ...(b.phone || [])])],
    email: [...new Set([...(a.email || []), ...(b.email || [])])],
    whatsapp: b.whatsapp || a.whatsapp,
    instagram: b.instagram || a.instagram,
    facebook: b.facebook || a.facebook,
    website: b.website || a.website,
    googleMapsUrl: b.googleMapsUrl || a.googleMapsUrl,
  };
}

export function emptyContacts(): ContactInfo {
  return {
    phone: [],
    email: [],
    whatsapp: undefined,
    instagram: undefined,
    facebook: undefined,
    website: undefined,
    googleMapsUrl: undefined,
  };
}

export function hasAnyContact(contacts: ContactInfo): boolean {
  return (
    contacts.phone.length > 0 ||
    contacts.email.length > 0 ||
    !!contacts.whatsapp ||
    !!contacts.instagram ||
    !!contacts.facebook ||
    !!contacts.website
  );
}

export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength - 3)}...`;
}

export function cleanPropertyName(name: string): string {
  return (
    name
      // Normalize whitespace
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      // Strip platform suffixes
      .replace(/\s*[-·|]\s*Airbnb.*$/i, '')
      .replace(/\s*[-·|]\s*Booking\.com.*$/i, '')
      .replace(/\s*[-·|]\s*VRBO.*$/i, '')
      .replace(/\s*[-·|]\s*Expedia.*$/i, '')
      // Strip generic listing descriptions (Airbnb pattern)
      .replace(
        /\s*-\s*(?:Villas?|Houses?|Apartments?|Condos?|Cabins?|Cottages?|Rooms?)\s+for\s+Rent\s+in\s+[^-]+$/i,
        '',
      )
      // Strip location suffix patterns
      .replace(/\s*-\s*[^-]+,\s*[^-]+,\s*[A-Za-z]+$/i, '')
      .trim()
  );
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

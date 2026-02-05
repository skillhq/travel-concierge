import type { CliContext } from '../cli/shared.js';
import type { AvailabilityResult } from './browser/types.js';
import type { ContactDossier, SourceInfo } from './concierge-client-types.js';
import type { PlaceDetails } from './goplaces.js';

export function formatDossier(dossier: ContactDossier, ctx: CliContext): string {
  if (ctx.json) {
    return JSON.stringify(dossier, null, 2);
  }

  const { colors } = ctx;
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(colors.highlight('═══════════════════════════════════════════════════════════'));
  lines.push(colors.highlight(`  CONTACT DOSSIER: ${dossier.property.name}`));
  lines.push(colors.highlight('═══════════════════════════════════════════════════════════'));
  lines.push('');

  // Property Info
  lines.push(colors.primary('▸ Property Information'));
  lines.push(`  ${colors.muted('Platform:')} ${dossier.property.platform}`);
  lines.push(`  ${colors.muted('Name:')} ${dossier.property.name}`);

  if (dossier.property.location.city || dossier.property.location.country) {
    const location = [
      dossier.property.location.city,
      dossier.property.location.region,
      dossier.property.location.country,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`  ${colors.muted('Location:')} ${location}`);
  }

  if (dossier.property.location.address) {
    lines.push(`  ${colors.muted('Address:')} ${dossier.property.location.address}`);
  }

  if (dossier.property.hostName) {
    lines.push(`  ${colors.muted('Host:')} ${dossier.property.hostName}`);
  }

  lines.push(`  ${colors.muted('Listing:')} ${dossier.property.listingUrl}`);
  lines.push('');

  // Contact Info
  lines.push(colors.primary('▸ Contact Information'));

  const { contacts } = dossier;

  if (contacts.phone.length > 0) {
    lines.push(`  ${colors.success('📞 Phone:')} ${contacts.phone.join(', ')}`);
  }

  if (contacts.email.length > 0) {
    lines.push(`  ${colors.success('📧 Email:')} ${contacts.email.join(', ')}`);
  }

  if (contacts.whatsapp) {
    lines.push(`  ${colors.success('💬 WhatsApp:')} ${contacts.whatsapp}`);
  }

  if (contacts.website) {
    lines.push(`  ${colors.success('🌐 Website:')} ${contacts.website}`);
  }

  if (contacts.instagram) {
    lines.push(`  ${colors.success('📸 Instagram:')} ${contacts.instagram}`);
  }

  if (contacts.facebook) {
    lines.push(`  ${colors.success('📘 Facebook:')} ${contacts.facebook}`);
  }

  if (contacts.googleMapsUrl) {
    lines.push(`  ${colors.success('📍 Google Maps:')} ${contacts.googleMapsUrl}`);
  }

  // Check if any contacts found
  const hasContacts =
    contacts.phone.length > 0 ||
    contacts.email.length > 0 ||
    contacts.whatsapp ||
    contacts.website ||
    contacts.instagram ||
    contacts.facebook;

  if (!hasContacts) {
    lines.push(`  ${colors.warning('No contact information found')}`);
  }

  lines.push('');

  // Sources
  if (dossier.sources.length > 0) {
    lines.push(colors.primary('▸ Sources'));
    for (const source of dossier.sources) {
      const confidence = formatConfidence(source.confidence, colors);
      const url = source.url ? ` - ${colors.muted(source.url)}` : '';
      const note = source.note ? ` (${source.note})` : '';
      lines.push(`  ${confidence} ${source.type}${url}${note}`);
    }
    lines.push('');
  }

  // Footer
  lines.push(colors.muted(`Searched at: ${dossier.searchedAt}`));
  lines.push('');

  return lines.join('\n');
}

function formatConfidence(confidence: SourceInfo['confidence'], colors: CliContext['colors']): string {
  switch (confidence) {
    case 'high':
      return colors.success('●');
    case 'medium':
      return colors.warning('●');
    case 'low':
      return colors.muted('●');
  }
}

export function formatError(error: string, ctx: CliContext): string {
  if (ctx.json) {
    return JSON.stringify({ success: false, error }, null, 2);
  }
  return ctx.colors.error(`Error: ${error}`);
}

export function formatInfo(message: string, ctx: CliContext): string {
  if (ctx.json) {
    return '';
  }
  return ctx.colors.info(message);
}

export function formatVerbose(message: string, ctx: CliContext): string {
  if (ctx.json || !ctx.verbose) {
    return '';
  }
  return ctx.colors.muted(`[verbose] ${message}`);
}

export function formatSearchResults(places: PlaceDetails[], ctx: CliContext): string {
  if (ctx.json) {
    return JSON.stringify(places, null, 2);
  }

  const { colors } = ctx;
  const lines: string[] = [];

  lines.push('');
  lines.push(colors.highlight(`Found ${places.length} accommodation(s)`));
  lines.push(colors.muted('────────────────────────────────────────────────────────────'));
  lines.push('');

  for (const place of places) {
    lines.push(colors.primary(`▸ ${place.name}`));

    if (place.address) {
      lines.push(`  ${colors.muted('Address:')} ${place.address}`);
    }

    if (place.phone) {
      lines.push(`  ${colors.muted('Phone:')} ${place.phone}`);
    }

    if (place.website) {
      lines.push(`  ${colors.muted('Website:')} ${place.website}`);
    }

    if (place.rating !== undefined) {
      const stars = formatStarRating(place.rating);
      const reviewCount = place.userRatingsTotal ? ` (${place.userRatingsTotal} reviews)` : '';
      lines.push(`  ${colors.muted('Rating:')} ${stars}${reviewCount}`);
    }

    if (place.mapsUrl) {
      lines.push(`  ${colors.muted('Maps:')} ${place.mapsUrl}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

function formatStarRating(rating: number): string {
  const fullStars = Math.floor(rating);
  const hasHalfStar = rating - fullStars >= 0.5;
  const emptyStars = 5 - fullStars - (hasHalfStar ? 1 : 0);

  return `${'★'.repeat(fullStars)}${hasHalfStar ? '½' : ''}${'☆'.repeat(emptyStars)} (${rating.toFixed(1)})`;
}

export function formatAvailabilityResult(result: AvailabilityResult, ctx: CliContext): string {
  if (ctx.json) {
    return JSON.stringify(result, null, 2);
  }

  const { colors } = ctx;
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(colors.highlight('═══════════════════════════════════════════════════════════'));
  lines.push(colors.highlight(`  HOTEL AVAILABILITY: ${result.hotelName}`));
  lines.push(colors.highlight('═══════════════════════════════════════════════════════════'));
  lines.push('');

  // Hotel info
  if (result.address || result.rating) {
    lines.push(colors.primary('▸ Hotel Info'));
    if (result.address) {
      lines.push(`  ${colors.muted('Address:')} ${result.address}`);
    }
    if (result.rating) {
      const reviewInfo = result.reviewCount ? ` (${result.reviewCount.toLocaleString()} reviews)` : '';
      lines.push(`  ${colors.muted('Rating:')}  ${result.rating}/10${reviewInfo}`);
    }
    lines.push('');
  }

  // Search details
  lines.push(colors.primary('▸ Search Details'));
  lines.push(`  ${colors.muted('Check-in:')}   ${formatDatePretty(result.checkIn)}`);
  lines.push(`  ${colors.muted('Check-out:')}  ${formatDatePretty(result.checkOut)}`);
  lines.push(`  ${colors.muted('Nights:')}     ${result.nights}`);
  lines.push(`  ${colors.muted('Guests:')}     ${result.guests}`);
  if (result.rooms > 1) {
    lines.push(`  ${colors.muted('Rooms:')}      ${result.rooms}`);
  }
  lines.push('');

  // Unavailable notice
  if (result.unavailable) {
    lines.push(colors.warning('⚠ This hotel is unavailable for your selected dates.'));
    lines.push('');
  }

  // Available rooms
  if (result.rooms_available.length > 0) {
    const sectionTitle = result.unavailable ? '▸ Alternative Dates' : '▸ Room Types';
    lines.push(colors.primary(sectionTitle));
    lines.push('');

    for (const room of result.rooms_available) {
      lines.push(`  ${colors.highlight(room.name)}`);

      // Bed and guest info
      if (room.beds || room.maxGuests) {
        const bedInfo = room.beds || '';
        const guestInfo = room.maxGuests ? `(max ${room.maxGuests} guests)` : '';
        const separator = bedInfo && guestInfo ? ' ' : '';
        lines.push(`    ${colors.muted(bedInfo + separator + guestInfo)}`);
      }

      // Price info
      if (room.pricePerNight && room.totalPrice) {
        lines.push(`    ${colors.success(room.pricePerNight)}/night · ${colors.success(room.totalPrice)} total`);
      } else if (room.totalPrice) {
        lines.push(`    ${colors.success(room.totalPrice)} total`);
      } else if (room.pricePerNight) {
        lines.push(`    ${colors.success(room.pricePerNight)}/night`);
      }

      // Features
      for (const feature of room.features) {
        lines.push(`    ${colors.success('✓')} ${feature}`);
      }

      // Warnings
      for (const warning of room.warnings) {
        lines.push(`    ${colors.warning('⚠')} ${warning}`);
      }

      lines.push('');
    }
  } else {
    lines.push(colors.warning('No room types found. Try visiting the URL directly.'));
    lines.push('');
  }

  // URL
  if (result.url) {
    lines.push(`${colors.muted('View on Booking.com:')} ${result.url}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatDatePretty(dateStr: string): string {
  const date = new Date(dateStr);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();

  return `${dayName}, ${monthName} ${day}, ${year}`;
}

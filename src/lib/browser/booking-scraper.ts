import type { Result } from '../concierge-client-types.js';
import {
  click,
  closeBrowser,
  isAgentBrowserInstalled,
  openUrl,
  screenshot,
  setHeadedMode,
  sleep,
  snapshot,
} from './agent-browser-client.js';
import type { AvailabilityResult, AvailabilitySearchParams, RoomInfo } from './types.js';

/**
 * Calculate nights between two dates
 */
function calculateNights(checkIn: string, checkOut: string): number {
  const inDate = new Date(checkIn);
  const outDate = new Date(checkOut);
  const diffTime = outDate.getTime() - inDate.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Check if URL is a Booking.com hotel URL
 */
function isBookingHotelUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('booking.com') && parsed.pathname.includes('/hotel/');
  } catch {
    return false;
  }
}

/**
 * Build Booking.com search URL for a hotel query
 */
function buildSearchUrl(query: string, checkIn: string, checkOut: string, guests: number, rooms: number): string {
  const url = new URL('https://www.booking.com/searchresults.html');
  url.searchParams.set('ss', query);
  url.searchParams.set('checkin', checkIn);
  url.searchParams.set('checkout', checkOut);
  url.searchParams.set('group_adults', guests.toString());
  url.searchParams.set('no_rooms', rooms.toString());
  url.searchParams.set('group_children', '0');
  return url.toString();
}

interface SearchResult {
  name: string;
  rating?: string;
  reviewCount?: number;
  location?: string;
  price?: string;
  currency?: string;
  unavailable?: boolean;
  alternativeDates?: { dates: string; price: string }[];
  ref?: string;
}

interface ParsedSearchResults {
  raw: string;
  hotels: SearchResult[];
  targetHotel?: SearchResult;
}

/**
 * Parse the search results page to extract hotel listings
 */
function parseSearchResults(rawOutput: string, targetQuery: string): ParsedSearchResults {
  const result: ParsedSearchResults = {
    raw: rawOutput,
    hotels: [],
  };

  const lines = rawOutput.split('\n');
  const queryLower = targetQuery.toLowerCase();

  // Track current hotel being parsed
  let currentHotel: SearchResult | null = null;

  for (const line of lines) {
    // Match hotel links in search results
    // Pattern: link "Hotel 4 out of 5 stars Ramada by Wyndham Lisbon 8.2 Very Good 3.2 km from downtown Starting from Price AED 976" [ref=e52]
    const hotelMatch = line.match(
      /link "(?:Hotel|Guesthouse|Apartment|Hostel|B&B|Resort|Villa)?\s*(\d+)?\s*out of \d+\s*(?:stars|quality rating)?\s*([^"]+?)\s+(\d+\.?\d*)\s+(Good|Very Good|Excellent|Exceptional|Superb|Wonderful|Fabulous|Pleasant|Review score)\s+[\d.]+\s*km from downtown\s+Starting from Price\s+([A-Z]{3})\s+([\d,]+)"\s*\[ref=(\w+)\]/i
    );

    if (hotelMatch) {
      const hotel: SearchResult = {
        name: hotelMatch[2].trim(),
        rating: hotelMatch[3],
        location: 'from downtown',
        currency: hotelMatch[5],
        price: `${hotelMatch[5]} ${hotelMatch[6]}`,
        ref: hotelMatch[7],
      };
      result.hotels.push(hotel);

      // Check if this is the target hotel
      if (hotel.name.toLowerCase().includes(queryLower) || queryLower.includes(hotel.name.toLowerCase())) {
        result.targetHotel = hotel;
      }
      continue;
    }

    // Match unavailable hotel with alternative dates
    // Pattern: link "Radisson Blu Hotel Lisbon Opens in new window This property is unavailable on our site for your dates" [ref=e35]
    const unavailableMatch = line.match(
      /link "([^"]+?)\s+Opens in new window\s+This property is unavailable[^"]*"\s*\[ref=(\w+)\]/i
    );

    if (unavailableMatch) {
      currentHotel = {
        name: unavailableMatch[1].trim(),
        unavailable: true,
        alternativeDates: [],
        ref: unavailableMatch[2],
      };

      // Check if this is the target hotel
      if (
        currentHotel.name.toLowerCase().includes(queryLower) ||
        queryLower.includes(currentHotel.name.toLowerCase())
      ) {
        result.targetHotel = currentHotel;
      }
      result.hotels.push(currentHotel);
      continue;
    }

    // Match rating for current hotel
    // Pattern: link "Scored 7.9 Good 10,849 reviews" [ref=e39]
    const ratingMatch = line.match(/link "Scored (\d+\.?\d*)\s+\w+\s+([\d,]+)\s*reviews"/i);
    if (ratingMatch && currentHotel) {
      currentHotel.rating = ratingMatch[1];
      currentHotel.reviewCount = parseInt(ratingMatch[2].replace(/,/g, ''), 10);
      continue;
    }

    // Match alternative dates with prices
    // Pattern: link "Feb 8 – Feb 9 1 night From AED 407.82" [ref=e40]
    const altDateMatch = line.match(/link "([A-Za-z]{3} \d+ – [A-Za-z]{3} \d+)\s+\d+\s+nights?\s+From\s+([A-Z]{3}\s+[\d,.]+)"/i);
    if (altDateMatch && currentHotel && currentHotel.unavailable) {
      currentHotel.alternativeDates = currentHotel.alternativeDates || [];
      currentHotel.alternativeDates.push({
        dates: altDateMatch[1],
        price: altDateMatch[2],
      });
      continue;
    }

    // Match location
    // Pattern: link "Alvalade, Lisbon · Show on map" [ref=e37]
    const locationMatch = line.match(/link "([^"]+)\s*·\s*Show on map"/i);
    if (locationMatch && currentHotel) {
      currentHotel.location = locationMatch[1];
      continue;
    }

    // Match room type links
    // Pattern: link "Deluxe Double Room" [ref=e87]
    const roomMatch = line.match(/link "((?:Deluxe|Standard|Superior|Classic|Premium|Double|Twin|Single|King|Queen|Suite|Studio|Apartment|Room)[^"]*)" \[ref=\w+\]/i);
    if (roomMatch && currentHotel) {
      // This indicates we're still on the same hotel's listing
      continue;
    }
  }

  return result;
}

/**
 * Dismiss sign-in modal if present
 */
function dismissSignInModal(rawSnapshot: string): boolean {
  // Look for: button "Dismiss sign-in info." [ref=e1]
  const dismissMatch = rawSnapshot.match(/button "Dismiss sign-in info[^"]*" \[ref=(\w+)\]/i);
  if (dismissMatch) {
    click(dismissMatch[1]);
    return true;
  }

  // Also try: button "Close" [ref=e51]
  const closeMatch = rawSnapshot.match(/button "Close" \[ref=(\w+)\]/i);
  if (closeMatch) {
    click(closeMatch[1]);
    return true;
  }

  return false;
}

/**
 * Check availability for a hotel on Booking.com
 */
export async function checkAvailability(params: AvailabilitySearchParams): Promise<Result<AvailabilityResult>> {
  if (!isAgentBrowserInstalled()) {
    return {
      success: false,
      error: 'agent-browser CLI is not installed. Install it to use availability checking.',
    };
  }

  const { query, checkIn, checkOut, guests, rooms } = params;
  const nights = calculateNights(checkIn, checkOut);

  // Use headed mode by default - Booking.com blocks headless browsers
  // Only use headless if explicitly requested (params.headed === false is not currently supported)
  setHeadedMode(true);

  // Build search URL with dates
  const targetUrl = isBookingHotelUrl(query)
    ? `${query}?checkin=${checkIn}&checkout=${checkOut}&group_adults=${guests}&no_rooms=${rooms}`
    : buildSearchUrl(query, checkIn, checkOut, guests, rooms);

  // Open the URL
  const openResult = openUrl(targetUrl);
  if (!openResult.success) {
    return openResult;
  }

  // Wait for page to load
  sleep(5000);

  // Get initial snapshot
  let snap = snapshot();
  if (!snap.success) {
    closeBrowser();
    return { success: false, error: 'Failed to get page snapshot' };
  }

  // Try to dismiss sign-in modal
  if (dismissSignInModal(snap.data.raw)) {
    sleep(1500);
    snap = snapshot();
    if (!snap.success) {
      closeBrowser();
      return { success: false, error: 'Failed to get page snapshot after dismissing modal' };
    }
  }

  // Parse search results
  const parsed = parseSearchResults(snap.data.raw, query);

  // Convert to rooms format
  const roomsAvailable: RoomInfo[] = [];

  if (parsed.targetHotel) {
    const hotel = parsed.targetHotel;

    if (hotel.unavailable && hotel.alternativeDates && hotel.alternativeDates.length > 0) {
      // Hotel is unavailable for requested dates, show alternative dates as "rooms"
      for (const alt of hotel.alternativeDates.slice(0, 5)) {
        roomsAvailable.push({
          name: `Alternative: ${alt.dates}`,
          totalPrice: alt.price,
          features: ['Different dates available'],
          warnings: ['Your requested dates are unavailable'],
        });
      }
    } else if (hotel.price) {
      // Hotel is available, show starting price
      roomsAvailable.push({
        name: 'Starting from',
        totalPrice: hotel.price,
        features: [],
        warnings: [],
      });
    }
  }

  // Get current URL
  const currentUrl = snap.success ? snap.data.url : undefined;

  // Take screenshot if requested
  if (params.screenshot) {
    screenshot(params.screenshot);
  }

  // Close browser unless headed mode explicitly requested to keep open
  if (!params.headed) {
    closeBrowser();
  }

  const targetHotel = parsed.targetHotel;

  return {
    success: true,
    data: {
      hotelName: targetHotel?.name || query,
      rating: targetHotel?.rating,
      reviewCount: targetHotel?.reviewCount,
      address: targetHotel?.location,
      checkIn,
      checkOut,
      nights,
      guests,
      rooms,
      rooms_available: roomsAvailable,
      url: currentUrl,
      unavailable: targetHotel?.unavailable,
    },
  };
}

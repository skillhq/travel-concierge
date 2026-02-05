import { spawnSync } from 'node:child_process';
import type { Result } from './concierge-client-types.js';

export interface PlaceSearchResult {
  id: string;
  name: string;
  address: string;
  rating?: number;
  userRatingsTotal?: number;
  types?: string[];
}

export interface PlaceDetails {
  id: string;
  name: string;
  address: string;
  phone?: string;
  website?: string;
  rating?: number;
  userRatingsTotal?: number;
  mapsUrl?: string;
  types?: string[];
}

export interface SearchOptions {
  limit?: number;
  minRating?: number;
  type?: string;
  radiusMeters?: number;
}

/**
 * Check if goplaces CLI is installed
 */
export function isGoplacesInstalled(): boolean {
  const result = spawnSync('which', ['goplaces'], { stdio: 'pipe' });
  return result.status === 0;
}

/**
 * Parse coordinates from string like "37.7749,-122.4194"
 */
function parseCoordinates(input: string): { lat: number; lng: number } | null {
  const match = input.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Search for places using goplaces CLI
 */
export function searchPlaces(query: string, options: SearchOptions = {}): Result<PlaceSearchResult[]> {
  if (!isGoplacesInstalled()) {
    return {
      success: false,
      error: 'goplaces CLI is not installed. No other providers are currently supported.',
    };
  }

  const coords = parseCoordinates(query);
  const limit = Math.min(options.limit ?? 10, 20);

  let args: string[];
  if (coords) {
    // Use nearby search for coordinates
    args = ['nearby', `${coords.lat},${coords.lng}`, '--json'];
    if (options.radiusMeters) {
      args.push('--radius', options.radiusMeters.toString());
    }
    if (options.type) {
      args.push('--type', options.type);
    } else {
      args.push('--type', 'lodging');
    }
  } else {
    // Use text search for queries
    args = ['search', query, '--json'];
    if (options.type) {
      args.push('--type', options.type);
    }
  }

  const result = spawnSync('goplaces', args, {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 30000,
  });

  if (result.error) {
    return { success: false, error: `Failed to run goplaces: ${result.error.message}` };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error';
    return { success: false, error: `goplaces search failed: ${stderr}` };
  }

  try {
    const places = JSON.parse(result.stdout) as PlaceSearchResult[];

    // Filter by rating if specified
    let filtered = places;
    if (options.minRating !== undefined) {
      filtered = places.filter((p) => p.rating !== undefined && p.rating >= options.minRating!);
    }

    // Apply limit
    return { success: true, data: filtered.slice(0, limit) };
  } catch {
    return { success: false, error: 'Failed to parse goplaces output' };
  }
}

/**
 * Get details for a single place
 */
export function getPlaceDetails(placeId: string): Result<PlaceDetails> {
  if (!isGoplacesInstalled()) {
    return {
      success: false,
      error: 'goplaces CLI is not installed. No other providers are currently supported.',
    };
  }

  const result = spawnSync('goplaces', ['details', placeId, '--json'], {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 15000,
  });

  if (result.error) {
    return { success: false, error: `Failed to run goplaces: ${result.error.message}` };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error';
    return { success: false, error: `goplaces details failed: ${stderr}` };
  }

  try {
    const details = JSON.parse(result.stdout) as PlaceDetails;
    return { success: true, data: details };
  } catch {
    return { success: false, error: 'Failed to parse goplaces output' };
  }
}

/**
 * Search for places and fetch details for each result
 */
export async function searchWithDetails(query: string, options: SearchOptions = {}): Promise<Result<PlaceDetails[]>> {
  const searchResult = searchPlaces(query, options);
  if (!searchResult.success) {
    return searchResult;
  }

  const places = searchResult.data;
  const results: PlaceDetails[] = [];

  for (const place of places) {
    const detailsResult = getPlaceDetails(place.id);
    if (detailsResult.success) {
      results.push(detailsResult.data);
    } else {
      // If details fail, use basic search data
      results.push({
        id: place.id,
        name: place.name,
        address: place.address,
        rating: place.rating,
        userRatingsTotal: place.userRatingsTotal,
        types: place.types,
      });
    }
  }

  return { success: true, data: results };
}

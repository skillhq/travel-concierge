// Supported accommodation platforms
export type Platform = 'airbnb' | 'booking' | 'vrbo' | 'expedia' | 'unknown';

// Location information
export interface LocationInfo {
  city?: string;
  region?: string;
  country?: string;
  address?: string;
  coordinates?: {
    lat: number;
    lng: number;
  };
}

// Property information extracted from listing
export interface PropertyInfo {
  platform: Platform;
  name: string;
  location: LocationInfo;
  hostName?: string;
  listingUrl: string;
}

// Contact information found
export interface ContactInfo {
  phone: string[];
  email: string[];
  whatsapp?: string;
  instagram?: string;
  facebook?: string;
  website?: string;
  googleMapsUrl?: string;
}

// Source information for confidence tracking
export type SourceType = 'listing' | 'website' | 'google-places' | 'instagram' | 'facebook' | 'google-search';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface SourceInfo {
  type: SourceType;
  url?: string;
  confidence: ConfidenceLevel;
  note?: string;
}

// Complete contact dossier output
export interface ContactDossier {
  property: PropertyInfo;
  contacts: ContactInfo;
  sources: SourceInfo[];
  searchedAt: string;
}

// Result pattern for error handling
export type Result<T> = { success: true; data: T } | { success: false; error: string };

// Configuration
export interface ConciergeConfig {
  googlePlacesApiKey?: string;
  instagramSessionId?: string;
  timeoutMs?: number;
  // Voice call configuration
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  deepgramApiKey?: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  ngrokAuthToken?: string;
  callServerPort?: number;
  // AI conversation
  anthropicApiKey?: string;
  // Call output
  callOutputDir?: string;
}

// Fetch options
export interface FetchOptions {
  timeout?: number;
  headers?: Record<string, string>;
}

// Mixin constructor type - uses any[] for proper mixin compatibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;

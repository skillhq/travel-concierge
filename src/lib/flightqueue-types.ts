export interface FlightQueueAirport {
  code: string;
  name: string;
  city: string;
  country: string;
}

export interface WaitTimeStatus {
  level: 'fast' | 'moderate' | 'busy' | 'very_busy' | 'unknown';
  minutes: number | null;
  description: string;
}

export interface FlightQueueData {
  airport: FlightQueueAirport;
  security: WaitTimeStatus;
  immigration: WaitTimeStatus;
  recommendedArrival: {
    domestic: number | null;
    international: number | null;
  };
  trafficScore: number | null;
  url: string;
  fetchedAt: string;
}

export interface FlightQueueSearchResult {
  airports: FlightQueueAirport[];
  query: string;
}

export type FlightQueueResult = { success: true; data: FlightQueueData } | { success: false; error: string };

export type FlightQueueSearchResponse =
  | { success: true; data: FlightQueueSearchResult }
  | { success: false; error: string };

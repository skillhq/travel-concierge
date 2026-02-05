export interface RoomInfo {
  name: string;
  beds?: string;
  maxGuests?: number;
  pricePerNight?: string;
  totalPrice?: string;
  features: string[];
  warnings: string[];
}

export interface AvailabilityResult {
  hotelName: string;
  address?: string;
  rating?: string;
  reviewCount?: number;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  rooms: number;
  rooms_available: RoomInfo[];
  url?: string;
  unavailable?: boolean;
}

export interface AvailabilitySearchParams {
  query: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  rooms: number;
  screenshot?: string;
  headed?: boolean;
}

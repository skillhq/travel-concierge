import { execSync } from 'node:child_process';
import type {
  FlightQueueAirport,
  FlightQueueData,
  FlightQueueResult,
  FlightQueueSearchResponse,
  WaitTimeStatus,
} from './flightqueue-types.js';

const FLIGHTQUEUE_BASE_URL = 'https://flightqueue.com';

// Use a counter to generate unique session names
let sessionCounter = 0;

export class FlightQueueClient {
  private verbose: boolean;
  private currentSession: string | null = null;

  constructor(options: { verbose?: boolean } = {}) {
    this.verbose = options.verbose ?? false;
  }

  private getNewSession(): string {
    sessionCounter++;
    this.currentSession = `fq-${process.pid}-${sessionCounter}`;
    return this.currentSession;
  }

  /**
   * Check if input looks like an airport code (3 uppercase letters)
   */
  isAirportCode(input: string): boolean {
    return /^[A-Z]{3}$/i.test(input.trim());
  }

  /**
   * Get wait times for an airport by code or city name
   */
  async getWaitTimes(input: string): Promise<FlightQueueResult> {
    const trimmed = input.trim();

    if (this.isAirportCode(trimmed)) {
      return this.getAirportWaitTimes(trimmed.toUpperCase());
    }

    // Search by city name first
    const searchResult = await this.searchAirportsOnly(trimmed);
    if (!searchResult.success) {
      return { success: false, error: searchResult.error };
    }

    if (searchResult.data.airports.length === 0) {
      return { success: false, error: `No airports found for "${trimmed}"` };
    }

    // Use the first result
    const airport = searchResult.data.airports[0];
    if (this.verbose) {
      console.log(`Found airport: ${airport.code} - ${airport.name}`);
    }

    // Get wait times using fresh browser session
    return this.getAirportWaitTimes(airport.code);
  }

  /**
   * Search for airports only (internal helper that closes browser)
   */
  private async searchAirportsOnly(query: string): Promise<FlightQueueSearchResponse> {
    const url = `${FLIGHTQUEUE_BASE_URL}/search?q=${encodeURIComponent(query)}`;
    const session = this.getNewSession();

    try {
      // Open the search page
      this.runAgentBrowser(`open "${url}"`, session);
      this.runAgentBrowser('wait 1500', session);

      // Get snapshot
      const snapshot = this.runAgentBrowser('snapshot', session);

      // Parse search results from snapshot
      const airports = this.parseSearchResults(snapshot);

      // Close browser
      this.closeSession();

      return {
        success: true,
        data: { airports, query },
      };
    } catch (error) {
      this.closeSession();
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to search airports',
      };
    }
  }

  /**
   * Search for airports by city/name
   */
  async searchAirports(query: string): Promise<FlightQueueSearchResponse> {
    const url = `${FLIGHTQUEUE_BASE_URL}/search?q=${encodeURIComponent(query)}`;

    try {
      // Open the search page
      this.runAgentBrowser(`open "${url}"`);

      // Wait a moment for page to fully render
      this.runAgentBrowser('wait 1000');

      // Get snapshot
      const snapshot = this.runAgentBrowser('snapshot');

      // Parse search results from snapshot
      const airports = this.parseSearchResults(snapshot);

      // Close browser
      this.closeSession();

      return {
        success: true,
        data: { airports, query },
      };
    } catch (error) {
      this.closeSession();
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to search airports',
      };
    }
  }

  /**
   * Get wait times for a specific airport code
   */
  private async getAirportWaitTimes(code: string): Promise<FlightQueueResult> {
    const url = `${FLIGHTQUEUE_BASE_URL}/airport/${code}`;
    const session = this.getNewSession();

    try {
      // Open the airport page
      this.runAgentBrowser(`open "${url}"`, session);

      // Wait a moment for page to fully render
      this.runAgentBrowser('wait 1500', session);

      // Get snapshot
      const snapshot = this.runAgentBrowser('snapshot', session);

      // Parse the airport data
      const data = this.parseAirportData(snapshot, code, url);

      // Close browser
      this.closeSession();

      return { success: true, data };
    } catch (error) {
      this.closeSession();
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get wait times',
      };
    }
  }

  private runAgentBrowser(command: string, session?: string): string {
    const sessionName = session ?? this.currentSession ?? this.getNewSession();
    try {
      const result = execSync(`agent-browser --session ${sessionName} ${command}`, {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result;
    } catch (error) {
      if (error instanceof Error && 'stderr' in error) {
        throw new Error(`agent-browser error: ${(error as { stderr: string }).stderr}`);
      }
      throw error;
    }
  }

  private closeSession(): void {
    if (!this.currentSession) return;
    try {
      execSync(`agent-browser --session ${this.currentSession} close`, {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Ignore close errors
    }
    this.currentSession = null;
  }

  private parseSearchResults(snapshot: string): FlightQueueAirport[] {
    const airports: FlightQueueAirport[] = [];

    // The snapshot format has search results in a single text line like:
    // "SEARCH RESULTS 3 airports found CODE AIRPORT CITY COUNTRY
    //  SWF New York Stewart International Airport Newburgh United States VIEW →
    //  JFK John F. Kennedy International Airport New York United States VIEW →"

    // First, find the search results section
    const searchSection = snapshot.match(
      /SEARCH RESULTS\s+\d+\s+airports?\s+found\s+CODE\s+AIRPORT\s+CITY\s+COUNTRY\s+(.+)/i,
    );

    if (searchSection) {
      const resultsText = searchSection[1];

      // Split by "VIEW →" to get individual airport entries
      const entries = resultsText.split(/VIEW\s*→/).filter((s) => s.trim());

      for (const entry of entries) {
        // Pattern: CODE followed by airport name (containing "Airport"), then city and country
        // Example: "JFK John F. Kennedy International Airport New York United States"
        const match = entry.trim().match(/^([A-Z]{3})\s+(.+?(?:Airport|International)[^\s]*)\s+(.+?)\s+([\w\s]+)$/i);

        if (match) {
          airports.push({
            code: match[1],
            name: match[2].trim(),
            city: match[3].trim(),
            country: match[4].trim(),
          });
        } else {
          // Simpler fallback: just get code and whatever follows
          const simpleMatch = entry.trim().match(/^([A-Z]{3})\s+(.+)/i);
          if (simpleMatch) {
            // Try to extract city from "... Airport CityName Country"
            const parts = simpleMatch[2].match(/(.+Airport)\s+(\w+(?:\s+\w+)?)\s+(\w+(?:\s+\w+)?)$/i);
            if (parts) {
              airports.push({
                code: simpleMatch[1],
                name: parts[1].trim(),
                city: parts[2].trim(),
                country: parts[3].trim(),
              });
            }
          }
        }
      }
    }

    // Fallback: look for individual airport patterns in snapshot
    if (airports.length === 0) {
      const codePattern = /([A-Z]{3})\s+(\w+(?:\s+\w+)*?)\s+International\s+Airport/gi;
      let match;
      while ((match = codePattern.exec(snapshot)) !== null) {
        airports.push({
          code: match[1],
          name: `${match[2]} International Airport`,
          city: match[2],
          country: '',
        });
      }
    }

    return airports;
  }

  private parseAirportData(snapshot: string, code: string, url: string): FlightQueueData {
    // Extract airport name from title or content
    const nameMatch = snapshot.match(
      /([A-Z]{3})\s+(?:Airport\s+)?Wait\s+Times\s*[-–]\s*(.+?)(?:\s+Security|\s+Immigration|$)/i,
    );
    const airportName = nameMatch ? nameMatch[2].trim() : `${code} Airport`;

    // Extract city from the airport name or page content
    const cityMatch = snapshot.match(/(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+International/);
    const city = cityMatch ? cityMatch[1] : '';

    // Parse security wait time
    const security = this.parseWaitTime(snapshot, 'security');

    // Parse immigration wait time
    const immigration = this.parseWaitTime(snapshot, 'immigration');

    // Parse traffic score
    const trafficMatch = snapshot.match(/Traffic\s+Score[:\s]+(\d+)/i);
    const trafficScore = trafficMatch ? parseInt(trafficMatch[1], 10) : null;

    // Parse recommended arrival times
    const domesticMatch = snapshot.match(/(\d+)\s*(?:min(?:utes)?)?.*?before\s+domestic/i);
    const internationalMatch = snapshot.match(/(\d+)\s*(?:min(?:utes)?)?.*?before\s+international/i);

    return {
      airport: {
        code,
        name: airportName,
        city,
        country: '',
      },
      security,
      immigration,
      recommendedArrival: {
        domestic: domesticMatch ? parseInt(domesticMatch[1], 10) : null,
        international: internationalMatch ? parseInt(internationalMatch[1], 10) : null,
      },
      trafficScore,
      url,
      fetchedAt: new Date().toISOString(),
    };
  }

  private parseWaitTime(snapshot: string, type: 'security' | 'immigration'): WaitTimeStatus {
    // Look for wait time patterns in the snapshot
    // Snapshot format examples:
    // - link "Security Wait  Very Busy  (45+ min)  for departing passengers..."
    // - link "Immigration  Fast  (under 15 min)  for arriving passengers..."
    // - button "Very Busy  (45+ min)"

    const patterns = [
      // Pattern: "Security Wait Very Busy (45+ min)" with extra spaces
      new RegExp(`${type}(?:\\s+Wait)?\\s+(Very\\s*Busy|Busy|Moderate|Fast)\\s*\\(([^)]+)\\)`, 'i'),
      // Pattern: "Security: 51 min"
      new RegExp(`${type}[:\\s]+(\\d+)\\s*min`, 'i'),
      // Pattern with just level (after type keyword)
      new RegExp(`${type}(?:\\s+Wait)?\\s+(Very\\s*Busy|Busy|Moderate|Fast)`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = snapshot.match(pattern);
      if (match) {
        if (match[2]) {
          // Has level and time description
          return {
            level: this.parseLevel(match[1]),
            minutes: this.parseMinutes(match[2]),
            description: `${match[1].replace(/\s+/g, ' ')} (${match[2]})`,
          };
        }
        if (/^\d+$/.test(match[1])) {
          // Just minutes
          const mins = parseInt(match[1], 10);
          return {
            level: this.minutesToLevel(mins),
            minutes: mins,
            description: `${mins} minutes`,
          };
        }
        // Just level
        return {
          level: this.parseLevel(match[1]),
          minutes: null,
          description: match[1].replace(/\s+/g, ' '),
        };
      }
    }

    return {
      level: 'unknown',
      minutes: null,
      description: 'Unknown',
    };
  }

  private parseLevel(text: string): WaitTimeStatus['level'] {
    const normalized = text.toLowerCase().replace(/\s+/g, '_');
    if (normalized.includes('very_busy') || normalized.includes('very busy')) return 'very_busy';
    if (normalized.includes('busy')) return 'busy';
    if (normalized.includes('moderate')) return 'moderate';
    if (normalized.includes('fast')) return 'fast';
    return 'unknown';
  }

  private parseMinutes(text: string): number | null {
    // "45+ min" -> 45
    // "under 15 min" -> 15
    // "15-30 min" -> average (22)
    const plusMatch = text.match(/(\d+)\+/);
    if (plusMatch) return parseInt(plusMatch[1], 10);

    const underMatch = text.match(/under\s+(\d+)/i);
    if (underMatch) return parseInt(underMatch[1], 10);

    const rangeMatch = text.match(/(\d+)\s*-\s*(\d+)/);
    if (rangeMatch) {
      return Math.round((parseInt(rangeMatch[1], 10) + parseInt(rangeMatch[2], 10)) / 2);
    }

    const simpleMatch = text.match(/(\d+)/);
    if (simpleMatch) return parseInt(simpleMatch[1], 10);

    return null;
  }

  private minutesToLevel(minutes: number): WaitTimeStatus['level'] {
    if (minutes < 15) return 'fast';
    if (minutes < 30) return 'moderate';
    if (minutes < 45) return 'busy';
    return 'very_busy';
  }
}

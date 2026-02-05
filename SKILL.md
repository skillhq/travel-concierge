---
name: concierge
description: Find accommodation contact details, search for hotels, check availability, and run AI-assisted booking calls
version: 1.5.0
triggers:
  - find contact
  - hotel contact
  - accommodation contact
  - property contact
  - airbnb contact
  - booking contact
  - vrbo contact
  - expedia contact
  - direct booking
  - property email
  - property phone
  - call hotel
  - call property
  - direct booking call
  - search hotels
  - find hotels
  - hotel search
  - check availability
  - hotel availability
  - room availability
---

# Travel Concierge

Find contact details (phone, email, WhatsApp, Instagram, etc.) for accommodation listings, search for hotels via Google Places, check availability on Booking.com, and place AI booking calls.

## Capabilities

### 1) Find contact details from a listing URL

```bash
concierge find-contact "<url>"
```

### 2) Search for accommodations

```bash
concierge search "hotels in San Francisco" --limit 5
concierge search "Paris" --min-rating 4 --json
concierge search "37.7749,-122.4194" --radius-m 5000 --type hotel
```

**Options:**
- `-l, --limit <n>` - Max results (default: 10, max: 20)
- `--min-rating <n>` - Minimum rating (0-5)
- `--type <type>` - Place type: lodging, hotel, resort_hotel (default: lodging)
- `--radius-m <meters>` - Search radius for coordinate searches

**Requires:** `goplaces` CLI installed

### 3) Check hotel availability on Booking.com

```bash
concierge check-availability "Park Hyatt Tokyo" -i 2024-03-15 -o 2024-03-17
concierge ca "https://www.booking.com/hotel/us/hilton.html" -i 2024-03-15 -o 2024-03-17 --json
concierge availability "Hilton NYC" -i 2024-04-01 -o 2024-04-03 -g 3 --screenshot results.png
```

**Options:**
- `-i, --check-in <date>` - Check-in date (YYYY-MM-DD) **required**
- `-o, --check-out <date>` - Check-out date (YYYY-MM-DD) **required**
- `-g, --guests <n>` - Number of guests (default: 2)
- `-r, --rooms <n>` - Number of rooms (default: 1)
- `-s, --screenshot <path>` - Save screenshot of results
- `--headed` - Show browser window (for debugging)

**Requires:** `agent-browser` CLI installed (with Playwright browsers)

### 4) Place an autonomous phone call

```bash
concierge call "+1-555-123-4567" \
  --goal "Book a room for March 12-14" \
  --name "Derek Rein" \
  --email "alexanderderekrein@gmail.com" \
  --customer-phone "+1-555-000-1111" \
  --context "Prefer direct booking if rate beats Booking.com"
```

The `call` command now auto-manages infra by default: if local server is down, it starts `ngrok` + call server automatically and stops both when the call ends.

## Supported listing platforms

- **Airbnb**: `airbnb.com/rooms/...`
- **Booking.com**: `booking.com/hotel/...`
- **VRBO**: `vrbo.com/...`
- **Expedia**: `expedia.com/...Hotel...`

## Examples

### Find contacts for an Airbnb listing
Run:
```bash
concierge find-contact "https://www.airbnb.com/rooms/12345"
```

### Search for hotels in a city
Run:
```bash
concierge search "hotels in Tokyo" --limit 5 --min-rating 4
```

### Check availability for a specific hotel
Run:
```bash
concierge ca "Hilton Garden Inn Times Square" -i 2024-05-01 -o 2024-05-03
```

### Start a call and control turns manually
Run:
```bash
concierge call "+1-555-123-4567" \
  --goal "Negotiate a direct booking rate" \
  --name "Derek Rein" \
  --email "alexanderderekrein@gmail.com" \
  --customer-phone "+1-555-000-1111" \
  --interactive
```

### JSON output for scripting (contact lookup)
```bash
concierge find-contact --json "https://..."
```

### Verbose output
```bash
concierge --verbose find-contact "https://..."
```

## Configuration

The CLI stores configuration in:

`~/.config/concierge/config.json5`

### Optional for contact lookup

```bash
concierge config set googlePlacesApiKey "your-key"
```

### Required for AI phone calls

```bash
concierge config set twilioAccountSid "<sid>"
concierge config set twilioAuthToken "<token>"
concierge config set twilioPhoneNumber "+14155551234"
concierge config set deepgramApiKey "<key>"
concierge config set elevenLabsApiKey "<key>"
concierge config set elevenLabsVoiceId "EXAVITQu4vr4xnSDxMaL"
concierge config set anthropicApiKey "<key>"

# Optional for auto ngrok auth
concierge config set ngrokAuthToken "<token>"
```

Check values:

```bash
concierge config show
```

## External Dependencies

| Feature | Required CLI | Install |
|---------|-------------|---------|
| `search` | `goplaces` | See goplaces documentation |
| `check-availability` | `agent-browser` | `npm install -g agent-browser && npx playwright install chromium` |
| `call` | `ffmpeg`, `ngrok` | `brew install ffmpeg ngrok` |

## Notes

- Contact extraction uses publicly available information.
- `search` uses Google Places API via the `goplaces` CLI.
- `check-availability` uses browser automation to scrape Booking.com. Results depend on DOM structure which may change.
- `call` validates local dependencies before dialing (`ffmpeg` with MP3 decode support, and `ngrok` when auto-infra is needed).
- `call` runs preflight checks for Twilio, Deepgram, and ElevenLabs quota before dialing.
- When auto infra is used, server/ngrok logs are written under `~/.config/concierge/call-runs/<run-id>/`.

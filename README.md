# Travel Concierge

Find accommodation contact details and place AI-powered booking calls.

## Installation

```bash
skill install @skillhq/travel-concierge
```

## Features

- **Contact Extraction**: Find phone, email, WhatsApp, and social media contacts from Airbnb, Booking.com, VRBO, and Expedia listings
- **AI Phone Calls**: Place autonomous phone calls with a goal-driven AI agent that handles the conversation until the goal is achieved

## Quick Start

### Find contacts for a listing

```bash
travel-concierge find-contact "https://www.airbnb.com/rooms/12345"
```

### Place an AI booking call

```bash
travel-concierge call "+1-555-123-4567" \
  --goal "Book a room for March 12-14" \
  --name "John Smith" \
  --email "john@example.com" \
  --customer-phone "+1-555-000-1111"
```

## Configuration

Configuration is stored in `~/.config/travel-concierge/config.json5`.

### For contact lookup (optional)

```bash
travel-concierge config set googlePlacesApiKey "your-key"
```

### For AI phone calls (required)

```bash
travel-concierge config set twilioAccountSid "<sid>"
travel-concierge config set twilioAuthToken "<token>"
travel-concierge config set twilioPhoneNumber "+14155551234"
travel-concierge config set deepgramApiKey "<key>"
travel-concierge config set elevenLabsApiKey "<key>"
travel-concierge config set elevenLabsVoiceId "EXAVITQu4vr4xnSDxMaL"
travel-concierge config set anthropicApiKey "<key>"
```

## Documentation

See [SKILL.md](./SKILL.md) for full documentation.

## License

MIT

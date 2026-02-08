/**
 * Conversation scripts for testing the voice pipeline
 * Each script simulates a realistic phone conversation
 */

export interface ConversationTurn {
  /** What the human says */
  human: string;
  /** Expected AI behavior (for validation) */
  expectedBehavior?: string;
  /** How long to wait before next turn (simulates thinking) */
  pauseMs?: number;
}

export interface ConversationScript {
  /** Unique ID for the script */
  id: string;
  /** Human-readable name */
  name: string;
  /** Goal passed to the AI */
  goal: string;
  /** Context passed to the AI */
  context?: string;
  /** The conversation turns */
  turns: ConversationTurn[];
  /** Expected outcome */
  expectedOutcome: 'success' | 'partial' | 'failure';
}

/**
 * Hotel booking scenarios
 */
export const HOTEL_SCRIPTS: ConversationScript[] = [
  {
    id: 'hotel-direct-booking-success',
    name: 'Hotel Direct Booking - Successful Discount',
    goal: 'Book a room directly and negotiate a 10% discount off the Booking.com rate',
    context:
      'Hotel: Haus im Tal, Munich. Room: Downtown Cozy. Dates: March 12-14. Booking.com rate: $393 for 2 nights. Guest: John Smith.',
    expectedOutcome: 'success',
    turns: [
      { human: 'Hello, Haus im Tal, how can I help you?' },
      { human: 'Yes, we have availability for those dates. What rate did you see online?', pauseMs: 500 },
      {
        human:
          'I see. Well, we do try to match or beat online rates for direct bookings. Let me check what I can offer.',
        pauseMs: 1000,
      },
      {
        human: 'I can offer you three hundred and fifty dollars for the two nights. Would that work for you?',
        pauseMs: 500,
      },
      { human: 'Great. I just need a name and email to confirm the booking.', pauseMs: 300 },
      { human: "Perfect, I've got John Smith. And the email?", pauseMs: 300 },
      {
        human: "Alright, you're all set. Confirmation number is H-T-four-five-six-seven. See you on March twelfth.",
        pauseMs: 500,
      },
    ],
  },
  {
    id: 'hotel-direct-booking-no-discount',
    name: 'Hotel Direct Booking - No Discount Available',
    goal: 'Book a room directly and negotiate a 10% discount off the Booking.com rate',
    context: 'Hotel: Grand Plaza. Room: Standard Queen. Dates: Dec 31 - Jan 2. Booking.com rate: $500 for 2 nights.',
    expectedOutcome: 'partial',
    turns: [
      { human: 'Grand Plaza, this is Michael speaking.' },
      {
        human:
          "I'm sorry, but those dates are during our peak season. We actually can't offer any discounts for New Year's Eve.",
        pauseMs: 500,
      },
      {
        human:
          "No, I'm afraid the online rate is already our best rate for those dates. It's our busiest time of year.",
        pauseMs: 800,
      },
      { human: 'I understand. Would you still like to proceed with the booking at the regular rate?', pauseMs: 500 },
    ],
  },
  {
    id: 'hotel-direct-booking-premium-link-flow',
    name: 'Hotel Direct Booking - Premium Link + Email Spelling',
    goal: 'Book directly, get a better direct rate, and provide email for a payment link',
    context:
      'Hotel: Haus im Tal, Munich. Room: Downtown Cozy. Dates: March 12-14. Booking.com rate: $393 for 2 nights. Guest: Derek Rein. Email: alexanderderekrein@gmail.com.',
    expectedOutcome: 'success',
    turns: [
      { human: 'Sure.' },
      { human: 'Yes.' },
      { human: 'Yes.' },
      { human: 'I need to email you a premium link. Does that work?', pauseMs: 400 },
      { human: 'Can you spell out the email again?', pauseMs: 400 },
      { human: 'Okay. Perfect.', pauseMs: 300 },
      { human: 'Yes.', pauseMs: 300 },
    ],
  },
  {
    id: 'hotel-no-availability',
    name: 'Hotel Direct Booking - No Availability',
    goal: 'Book a room directly for March 15-17',
    context: 'Hotel: Beach Resort. Room: Ocean View Suite.',
    expectedOutcome: 'failure',
    turns: [
      { human: 'Beach Resort, good afternoon.' },
      { human: "I'm sorry, but we're completely booked for those dates. There's a conference in town.", pauseMs: 500 },
      { human: 'The earliest availability I have is March twentieth. Would that work instead?', pauseMs: 800 },
      { human: 'I understand. Would you like me to put you on a waitlist in case of cancellations?', pauseMs: 500 },
    ],
  },
  {
    id: 'hotel-quick-agreement',
    name: 'Hotel Quick Agreement - Test Role Consistency',
    goal: 'Book a room directly and get a confirmation number',
    context:
      'Hotel: Haus im Tal, Munich. Room: Downtown Cozy. Dates: March 12-14. Customer: Derek Rein. Email: derek@example.com. Phone: 555-123-4567.',
    expectedOutcome: 'success',
    turns: [
      { human: 'Hello, Haus im Tal.' },
      { human: 'Mhmm.', pauseMs: 500 },
      { human: 'Not sure. What did you have in mind?', pauseMs: 800 },
      { human: 'Yeah. Sure.', pauseMs: 500 },
      { human: 'Yes.', pauseMs: 300 },
      { human: 'Yes.', pauseMs: 300 },
      {
        human: 'The confirmation number is H-T-seven-eight-nine-zero. I have your email as derek at example dot com.',
        pauseMs: 500,
      },
    ],
    // This test specifically checks that the AI:
    // 1. Stays in the caller/customer role throughout
    // 2. Asks the hotel for a confirmation number
    // 3. Provides the customer email for confirmations
    // 4. Doesn't switch to hotel employee phrases like "Does this look correct to you?"
  },
];

/**
 * Restaurant reservation scenarios
 */
export const RESTAURANT_SCRIPTS: ConversationScript[] = [
  {
    id: 'restaurant-reservation-success',
    name: 'Restaurant Reservation - Success',
    goal: 'Make a dinner reservation for 4 people',
    context: 'Restaurant: Chez Marie. Date: Saturday at 7pm. Party size: 4. Name: Sarah Johnson.',
    expectedOutcome: 'success',
    turns: [
      { human: 'Chez Marie, how may I help you?' },
      {
        human: 'Saturday evening for four? Let me check... Yes, we have seven and eight thirty available.',
        pauseMs: 800,
      },
      { human: 'Seven oclock it is. And the name for the reservation?', pauseMs: 300 },
      { human: 'Sarah Johnson, party of four, Saturday at seven. Is there anything else?', pauseMs: 300 },
      { human: 'Perfect. We look forward to seeing you Saturday. Goodbye.', pauseMs: 300 },
    ],
  },
  {
    id: 'restaurant-dietary-requirements',
    name: 'Restaurant with Dietary Requirements',
    goal: 'Make a reservation and confirm they can accommodate dietary restrictions',
    context:
      'Restaurant: Italian Bistro. Date: Friday 6:30pm. Party: 2. Requirements: One person is vegan, one has gluten allergy.',
    expectedOutcome: 'success',
    turns: [
      { human: 'Italian Bistro, good evening.' },
      {
        human: 'Friday at six thirty for two? Yes, that should be fine. Did you have any special requests?',
        pauseMs: 500,
      },
      {
        human:
          "Absolutely, we have several vegan pasta options and all our dishes can be made gluten-free. I'll make a note on the reservation.",
        pauseMs: 800,
      },
      { human: 'And what name should I put this under?', pauseMs: 300 },
      { human: 'All set. See you Friday at six thirty.', pauseMs: 300 },
    ],
  },
];

/**
 * Hold queue scenarios - automated systems before human answers
 */
export const HOLD_QUEUE_SCRIPTS: ConversationScript[] = [
  {
    id: 'hotel-ivr-queue',
    name: 'Hotel IVR + Hold Queue',
    goal: 'Book a hotel room for March 15-17',
    context: 'Hotel: Marriott Downtown. Customer: John Smith.',
    expectedOutcome: 'success',
    turns: [
      {
        human:
          'Thank you for calling Marriott Downtown. Your call is important to us. Please hold for the next available representative.',
        pauseMs: 500,
      },
      { human: '...', pauseMs: 2000 }, // Hold music
      { human: 'Thank you for holding. Your estimated wait time is two minutes.', pauseMs: 500 },
      { human: '...', pauseMs: 3000 }, // More hold music
      { human: 'Thank you for your patience. This is Sarah, how may I assist you today?', pauseMs: 500 },
      {
        human: 'Sure, let me check availability for March fifteenth through seventeenth. One moment please.',
        pauseMs: 1000,
      },
      {
        human: 'Yes, we have a king room available for those dates at two hundred forty nine per night.',
        pauseMs: 500,
      },
      {
        human: 'Perfect, I have that booked for John Smith. You will receive a confirmation email shortly.',
        pauseMs: 300,
      },
    ],
  },
  {
    id: 'restaurant-busy-hold',
    name: 'Busy Restaurant Hold',
    goal: 'Make a dinner reservation for 4 people on Saturday at 7pm',
    context: 'Restaurant: The Italian Place. Party size: 4. Customer: Jane Doe.',
    expectedOutcome: 'success',
    turns: [
      { human: 'The Italian Place, please hold.', pauseMs: 200 },
      { human: '...', pauseMs: 4000 }, // Long hold
      { human: 'Sorry about that wait, we are very busy tonight. How can I help?', pauseMs: 500 },
      { human: 'Saturday at seven for four people? Let me check... yes we can do that. Name?', pauseMs: 500 },
      { human: 'Jane Doe, party of four, Saturday seven pm. Got it. See you then!', pauseMs: 300 },
    ],
  },
  {
    id: 'hotel-full-ivr',
    name: 'Hotel Full IVR Menu',
    goal: 'Book a room',
    context: 'Hotel: Hilton Garden Inn. Customer: Bob Wilson.',
    expectedOutcome: 'success',
    turns: [
      {
        human:
          'Thank you for calling Hilton Garden Inn. For reservations, press 1. For an existing reservation, press 2. For the front desk, press 3. Or stay on the line to speak with an operator.',
        expectedBehavior: 'should emit [DTMF:1] to select reservations',
        pauseMs: 500,
      },
      { human: 'Connecting you to reservations. Please hold.', pauseMs: 500 },
      { human: '...', pauseMs: 2000 }, // Hold music
      { human: 'Reservations, this is Mike. How can I help you?', pauseMs: 500 },
      { human: 'What dates are you looking at?', pauseMs: 300 },
      { human: 'Let me see what we have... yes, we have availability. Would you like to proceed?', pauseMs: 500 },
      { human: 'Great, booking confirmed for Bob Wilson.', pauseMs: 300 },
    ],
  },
  {
    id: 'callback-option',
    name: 'Callback Option Offered',
    goal: 'Book a hotel room',
    context: 'Hotel: Best Western. Customer: Alice Brown.',
    expectedOutcome: 'success',
    turns: [
      {
        human:
          'Thank you for calling Best Western. All of our agents are currently busy. Your estimated wait time is fifteen minutes. Press 1 to receive a callback, or stay on the line.',
        expectedBehavior:
          'should stay on the line (no DTMF) or press 0 for operator — not press 1 for callback since AI cannot receive callbacks',
        pauseMs: 500,
      },
      { human: '...', pauseMs: 3000 }, // Waiting on hold
      { human: 'Thank you for holding. You are next in queue.', pauseMs: 500 },
      { human: '...', pauseMs: 1500 },
      { human: 'Best Western reservations, this is Tom. Sorry for the wait. How can I help?', pauseMs: 500 },
      { human: 'Sure, what dates do you need?', pauseMs: 300 },
      { human: 'Got it. I can book that for you right now. Name on the reservation?', pauseMs: 500 },
      { human: 'Alice Brown. All set, confirmation number is BW twelve thirty four.', pauseMs: 300 },
    ],
  },
  {
    id: 'transferred-call',
    name: 'Call Gets Transferred',
    goal: 'Ask about room rates',
    context: 'Hotel: Holiday Inn Express.',
    expectedOutcome: 'success',
    turns: [
      { human: 'Holiday Inn Express, front desk.', pauseMs: 300 },
      {
        human: 'Oh, for rates you will need to speak with reservations. Let me transfer you. One moment.',
        pauseMs: 500,
      },
      { human: '...', pauseMs: 2000 }, // Transfer hold
      { human: 'Reservations, this is Linda.', pauseMs: 300 },
      { human: 'Our standard room is one twenty nine per night, and the suite is one seventy nine.', pauseMs: 500 },
      { human: 'Is there anything else I can help you with?', pauseMs: 300 },
    ],
  },
  {
    id: 'hotel-ivr-transfer-interruption',
    name: 'Hotel IVR Transfer with Interruption and Agent Ending Call',
    goal: 'Book a room directly at One&Only Royal Mirage for 2026-05-06 to 2026-05-09 and request a direct-booking discount',
    context:
      'Hotel: One&Only Royal Mirage. Room preference: Palace Superior Twin Room. Dates: 2026-05-06 to 2026-05-09. Customer: Derek Rein (spelled D-E-R-E-K R-E-I-N). Email: alexanderderekrein@gmail.com.',
    expectedOutcome: 'partial',
    turns: [
      { human: 'Thank you for calling One and Only Royal Mirage.', pauseMs: 300 },
      { human: 'This call may be recorded for quality assurance and training purposes.', pauseMs: 300 },
      {
        human: 'For room reservations, press 1. For restaurant reservations, press 2. For spa reservations, press 3.',
        expectedBehavior: 'should emit [DTMF:1] for reservations',
        pauseMs: 500,
      },
      { human: 'Good afternoon. Reservation. This is Jan. How may I assist you?', pauseMs: 500 },
      {
        human: 'Hello?',
        expectedBehavior:
          'should NOT repeat the full booking details verbatim — just re-engage naturally and confirm they can hear',
        pauseMs: 500,
      },
      { human: 'Yes. Yes, I can hear you.', pauseMs: 300 },
      {
        human: "Sir, I'll be more than happy to assist you with that. Allow me a moment. Can I have your name, please?",
        expectedBehavior: 'should give the name without repeating dates/room/rate again',
        pauseMs: 500,
      },
      {
        human: 'Hello? May I have your name, please?',
        expectedBehavior: 'should spell the name correctly: D-E-R-E-K R-E-I-N (not D-R-E-K)',
        pauseMs: 500,
      },
      { human: 'And how many adults will stay?', pauseMs: 300 },
      {
        human: 'Allow me a moment. Can I put you on hold for a second, please?',
        pauseMs: 500,
      },
      { human: '...', pauseMs: 4000 },
      {
        human: 'Good afternoon. Thanks for holding the line. May I have the dates and room type again please?',
        expectedBehavior: 'should wait for agent to finish speaking before responding — do NOT interrupt',
        pauseMs: 800,
      },
      {
        human:
          "I'm so sorry. I will have to end the call. Once you have the details ready, please give us a call back.",
        expectedBehavior:
          'should accept gracefully that the agent is ending the call — do NOT try to keep them on the line or ask for transfer',
        pauseMs: 500,
      },
      { human: 'Have a nice day.', pauseMs: 300 },
    ],
  },
  {
    id: 'transferred-call-non-english',
    name: 'Call Transferred to Non-English Speaker',
    goal: 'Book an Ocean View Pool Junior Suite at Trisara Resort for May 6, 2026 to May 9, 2026',
    context: 'Hotel: Trisara Resort, Phuket. Customer: Derek Rein. Email: alexanderderekrein@gmail.com.',
    expectedOutcome: 'partial',
    turns: [
      { human: 'Phone moment, please. Pass your line to room reservation.' },
      { human: '...', pauseMs: 2000 },
      // After transfer, new person speaks — simulating what WOULD happen
      // if unclear speech triggers the re-engagement response
      { human: 'Yes, reservations, how can I help?', pauseMs: 500 },
      { human: 'May sixth to ninth? Let me check availability.', pauseMs: 800 },
      { human: 'Yes, we have an Ocean View Pool Junior Suite available. Shall I book it?', pauseMs: 500 },
    ],
  },
  // Regression: +6676372400 (Banyan Tree Phuket, 2026-02-07) — after transfer, AI dumped
  // all booking details in one sentence. Staff (non-native English) couldn't parse dates,
  // took 6 attempts. AI never escalated to digit-by-digit format.
  {
    id: 'banyan-tree-date-confusion',
    name: 'Banyan Tree Transfer + Date Confusion (Regression)',
    goal: 'Book a Pool Villa at Banyan Tree Phuket for May 6, 2026 to May 9, 2026',
    context:
      'Hotel: Banyan Tree Phuket. Room: Pool Villa. Dates: 2026-05-06 to 2026-05-09. ' +
      'Customer: Derek Rein (D-E-R-E-K R-E-I-N). Email: alexanderderekrein@gmail.com.',
    expectedOutcome: 'partial',
    turns: [
      { human: 'Thank you for calling Banyan Tree Phuket. Let me transfer you to reservations.', pauseMs: 300 },
      { human: '...', pauseMs: 2000 },
      {
        human: 'Hello, reservations. How can I help you?',
        expectedBehavior:
          'should re-introduce briefly and state purpose (e.g. "room booking") — NOT dump villa + dates + year + guest count + name all at once',
        pauseMs: 500,
      },
      {
        human: 'Which villa would you like?',
        expectedBehavior: 'should answer ONLY the villa type — not add dates or other details',
        pauseMs: 500,
      },
      {
        human: 'And from which date?',
        expectedBehavior:
          'should give dates with day-of-week anchoring: "Wednesday, May sixth to Saturday, May ninth, twenty twenty-six"',
        pauseMs: 500,
      },
      {
        human: "Sorry, I didn't catch the date. Could you repeat?",
        expectedBehavior:
          'should escalate format — separate check-in/check-out: "Check-in: Wednesday, May sixth. Check-out: Saturday, May ninth."',
        pauseMs: 500,
      },
      {
        human: 'What date?',
        expectedBehavior:
          'should escalate further — cardinal numbers: "Day six of May to day nine of May, twenty twenty-six" — NOT repeat previous format',
        pauseMs: 500,
      },
      {
        human: 'What is the check-in?',
        expectedBehavior: 'should give ONLY the check-in date — NOT both dates',
        pauseMs: 500,
      },
    ],
  },
  // Regression: +6676310100 (Trisara, 2026-02-07) — after transfer, AI gave canned
  // "Hi, sorry about that!" instead of re-introducing itself. Hotel asked "send email
  // to us" and AI gave its own email. AI also dropped "R-E-I-N" from email spelling.
  {
    id: 'trisara-transfer-email-spelling',
    name: 'Trisara Resort Transfer + Email Request + Spelling (Regression)',
    goal: 'Book an Ocean View Pool Junior Suite at Trisara Resort for May 6, 2026 to May 9, 2026',
    context:
      'Hotel: Trisara Resort, Phuket. Customer: Derek Rein (D-E-R-E-K R-E-I-N). ' +
      'Email: alexanderderekrein@gmail.com. Room: Ocean View Pool Junior Suite.',
    expectedOutcome: 'partial',
    turns: [
      { human: 'Thank you for calling. Let me connect you to reservations.', pauseMs: 300 },
      { human: '...', pauseMs: 2000 },
      {
        human: 'Hello?',
        expectedBehavior:
          'should re-introduce itself as an AI assistant calling on behalf of the customer — NOT give a canned "Hi, sorry about that! Can you hear me okay?"',
        pauseMs: 500,
      },
      {
        human: 'Yes, I can hear you. How may I help?',
        pauseMs: 500,
      },
      {
        human: 'Could you send email to us, please?',
        expectedBehavior:
          'should explain it CANNOT send emails since it is an AI on a phone call — should NOT give its own email address as if sending an email',
        pauseMs: 500,
      },
      {
        human: 'May I have the email address please?',
        expectedBehavior:
          'should spell out the COMPLETE email: A-L-E-X-A-N-D-E-R-D-E-R-E-K-R-E-I-N at gmail dot com — must NOT drop letters',
        pauseMs: 500,
      },
    ],
  },
];

/**
 * Challenging conversation scenarios (edge cases)
 */
// Regression: +4989904218410 call failed because the hotel answered during AI greeting
// playback still buffered in Twilio. TTS generates audio faster than real-time, so the
// decoder closes (and echo suppression lifts) before Twilio finishes playing. The hotel
// person's speech leaked through and triggered an overlapping AI response — 11 second
// monologue, hotel hung up. The fix extends suppressSttUntilMs to cover estimated
// buffered Twilio playback (decoderBytes / 8 - streamingElapsed + 300ms).
export const EDGE_CASE_SCRIPTS: ConversationScript[] = [
  {
    id: 'greeting-overlap-echo',
    name: 'Hotel Answers During AI Greeting Playback',
    goal: 'Book a room directly at Grand Hotel for March 15-17',
    context:
      'Hotel: Grand Hotel. Room: Standard Double. Dates: March 15-17. ' +
      'Customer: John Smith (to spell: J-O-H-N S-M-I-T-H). Email: john@example.com. Phone: +1-555-000-1234.',
    expectedOutcome: 'success',
    turns: [
      {
        human: 'Hello, Grand Hotel, how can I help you?',
        expectedBehavior:
          'should NOT produce garbled overlapping audio — echo suppression must cover full Twilio playback buffer, not just decoder close time',
        pauseMs: 100,
      },
      {
        human: 'Hello? Are you there?',
        expectedBehavior:
          'should respond naturally once greeting finishes — briefly restate purpose, do NOT repeat the greeting or dump all booking details',
        pauseMs: 3000,
      },
      { human: 'Sure, what dates are you looking at?', pauseMs: 500 },
      {
        human:
          'Let me check... yes we have availability for March fifteenth through seventeenth. Would you like to book?',
        pauseMs: 800,
      },
      { human: 'Name for the reservation?', pauseMs: 300 },
      {
        human:
          "All set, John Smith, March fifteenth through seventeenth. You're confirmed. Confirmation number is GH-40821.",
        pauseMs: 500,
      },
    ],
  },
  {
    id: 'hold-please',
    name: 'Put on Hold Mid-Conversation',
    goal: 'Book a hotel room',
    context: 'Hotel: Test Hotel. Dates: Any available.',
    expectedOutcome: 'success',
    turns: [
      { human: 'Test Hotel, how can I help?' },
      { human: 'Sure, let me check on that. Can you hold for just a moment?', pauseMs: 500 },
      { human: '...', pauseMs: 3000 }, // Hold
      { human: 'Thanks for holding. Yes, we have rooms available. Would you like to book?', pauseMs: 500 },
      { human: "Great, you're all set.", pauseMs: 300 },
    ],
  },
  {
    id: 'background-noise',
    name: 'Noisy Background',
    goal: 'Get business hours',
    context: 'Business: Local Shop',
    expectedOutcome: 'success',
    turns: [
      { human: "Hello? Sorry, it's a bit loud here. Can you speak up?", pauseMs: 500 },
      {
        human: "Business hours? We're open nine to five Monday through Friday, and ten to three on Saturdays.",
        pauseMs: 800,
      },
      { human: 'Yes, nine to five weekdays. Anything else?', pauseMs: 300 },
    ],
  },
  {
    id: 'unclear-response',
    name: 'Unclear/Mumbled Response',
    goal: 'Confirm a reservation',
    context: 'Confirmation number: ABC123',
    expectedOutcome: 'partial',
    turns: [
      { human: 'Hmm... let me see... uh... what was the name again?', pauseMs: 1000 },
      { human: 'Ah yes... mmhmm... I think I found it... or maybe not...', pauseMs: 1500 },
      { human: 'Actually, could you give me the confirmation number?', pauseMs: 500 },
      { human: 'Got it. Yes, your reservation is confirmed.', pauseMs: 300 },
    ],
  },
  {
    id: 'interruption',
    name: 'Speaker Gets Interrupted',
    goal: 'Ask about pricing',
    context: 'Service: Car rental',
    expectedOutcome: 'success',
    turns: [
      { human: 'Car rentals, how can I—hold on one second—sorry about that, how can I help?', pauseMs: 500 },
      {
        human:
          'Daily rates start at forty-nine ninety-nine for a compact, or—wait, let me transfer you to—actually no, I can help. What type of car?',
        pauseMs: 800,
      },
      { human: 'A midsize is seventy-nine per day. Need any other info?', pauseMs: 300 },
    ],
  },
  {
    id: 'rapid-speech',
    name: 'Fast Talker',
    goal: 'Get store address',
    context: 'Store: Electronics Plus',
    expectedOutcome: 'success',
    turns: [
      { human: 'ElectronicsPlushowareyoutodayhowcanIhelpyou?', pauseMs: 200 },
      { human: 'Addressisonetwothreemainstreetdowntownnexttothecoffeeshopcantopennintosixyougotit?', pauseMs: 200 },
      { human: 'Yeponetwothreemainstreetseeyousoon!', pauseMs: 200 },
    ],
  },
  // Regression: +6676317200 (Trisara resort, Thailand) — hotel agent couldn't parse spoken
  // English dates. "twenty twenty-six" was heard as "76" then "1999". AI repeated same
  // phrasing verbatim, said "next year" (wrong — it IS this year), and said "just myself"
  // instead of "the guest".
  {
    id: 'non-native-english-date-confusion',
    name: 'Non-Native English Speaker - Date Confusion (Trisara)',
    goal: 'Book an Ocean View Pool Junior Suite at Trisara Resort for May 6, 2026 to May 9, 2026',
    context:
      'Hotel: Trisara Resort, Phuket. Room: Ocean View Pool Junior Suite. ' +
      'Dates: May 6, 2026 to May 9, 2026. Customer: Derek Rein (D-E-R-E-K R-E-I-N). ' +
      'Email: alexanderderekrein@gmail.com.',
    expectedOutcome: 'partial',
    turns: [
      { human: 'Thank you for calling. How may I help you?', pauseMs: 300 },
      { human: "Yes, ma'am.", pauseMs: 300 },
      {
        human: 'Let me transfer you to reservation, please.',
        expectedBehavior: 'should accept the transfer — "Sure, I\'ll hold" or similar',
        pauseMs: 2000,
      },
      { human: 'Reservation. Sandra speaking. How may I assist you?', pauseMs: 500 },
      {
        human: 'Which month?',
        expectedBehavior: 'should provide month and dates clearly — not repeat the whole pitch',
        pauseMs: 500,
      },
      {
        human: 'Could you provide me the period of stay? Check-in and check-out date.',
        expectedBehavior: 'should give check-in and check-out dates separately, include year',
        pauseMs: 500,
      },
      {
        human: 'Twenty twenty six?',
        expectedBehavior: 'should confirm year clearly — "two thousand twenty-six" — NEVER say "next year"',
        pauseMs: 500,
      },
      {
        human: 'I mean, the date. The date checking in.',
        expectedBehavior:
          'should give JUST the check-in date in a DIFFERENT format — MUST NOT repeat previous answer verbatim',
        pauseMs: 500,
      },
      {
        human: 'Could you repeat when you would like to check in and check out?',
        expectedBehavior: 'should rephrase in simpler format (digits, day/month/year) — NOT verbatim same response',
        pauseMs: 500,
      },
      {
        human: 'May 6 to May 9. How many people?',
        expectedBehavior: 'should say "one guest" or "for Derek Rein" — NEVER say "myself" or "just me"',
        pauseMs: 500,
      },
      {
        human: 'Where are you calling from?',
        expectedBehavior: 'should explain calling on behalf of the guest, not imply the AI is the guest',
        pauseMs: 500,
      },
      {
        human: 'Alright. Please hold one moment.',
        expectedBehavior: 'brief hold acknowledgement',
        pauseMs: 500,
      },
    ],
  },
];

/**
 * All scripts combined
 */
export const ALL_SCRIPTS: ConversationScript[] = [
  ...HOTEL_SCRIPTS,
  ...RESTAURANT_SCRIPTS,
  ...HOLD_QUEUE_SCRIPTS,
  ...EDGE_CASE_SCRIPTS,
];

/**
 * Get a script by ID
 */
export function getScript(id: string): ConversationScript | undefined {
  return ALL_SCRIPTS.find((s) => s.id === id);
}

/**
 * Get scripts by category
 */
export function getScriptsByCategory(category: 'hotel' | 'restaurant' | 'hold' | 'edge'): ConversationScript[] {
  switch (category) {
    case 'hotel':
      return HOTEL_SCRIPTS;
    case 'restaurant':
      return RESTAURANT_SCRIPTS;
    case 'hold':
      return HOLD_QUEUE_SCRIPTS;
    case 'edge':
      return EDGE_CASE_SCRIPTS;
  }
}

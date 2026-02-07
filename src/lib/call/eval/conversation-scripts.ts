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
        pauseMs: 500,
      },
      { human: '...', pauseMs: 1500 }, // Waiting
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
    id: 'transferred-call-non-english',
    name: 'Call Transferred to Non-English Speaker',
    goal: 'Book an Ocean View Pool Junior Suite at Trisara Resort for May 6-9, 2026',
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
];

/**
 * Challenging conversation scenarios (edge cases)
 */
export const EDGE_CASE_SCRIPTS: ConversationScript[] = [
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

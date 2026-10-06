---
id: google-calendar
title: Google Calendar
summary: Once you connect it, I can see what's on your calendar and when you're free — read-only.
where: approve it when you sign in with Google, or the ⋯ menu (top right) → Connected apps → Google → Calendar → Connect
status: live
surfaces: [companion]
audiences: [adult]
triggers: [calendar, google calendar, schedule, agenda, appointment, appointments, meeting, meetings, event, events, availability, free, busy, booked, tonight, tomorrow, plans, going on, this weekend]
---

## What I can do

With Google Calendar connected I can see your upcoming events and your
free/busy time, and use them naturally — what's on today, whether Thursday
afternoon is clear, what time the thing you mentioned actually starts.

I read across the calendars your account can see, not just the default one, and
I only look when what you said is plausibly about your schedule. You don't have
to say "calendar" — "anything going on tonight?" or "what am I doing tomorrow?"
is enough, and "tonight" means today's calendar, not tomorrow's.

I also notice the Working location you set in Google Calendar ("Home", "Office",
or a place you named). I keep it apart from your schedule — it says where you
are, not that you're in a meeting — so it never shows up as an appointment and
never counts as a clash with anything else.

I can't go and look something up partway through a reply. If your calendar
isn't in front of me for what you asked, I'll say so rather than promise to
check.

## Where to find it

Signing in with Google asks for Calendar along with Gmail and Contacts on one
Google screen — leave it ticked and it's connected, renewed each sign-in.

Otherwise: the **⋯ menu in the top right corner** → **Connected apps** → the
**Google** card → the **Calendar** row → **Connect**. Google's own page opens
and asks you to approve access to your calendar. Approve it and you land back
here connected — no consent step beyond Google's own.

To turn it off, the same row has **Off**. That deletes the stored token; Google
is told to revoke its approval once no other Google service is on (or use
**Disconnect all** on the card).

## When it doesn't work

- **I say you're not connected.** Either you haven't linked it, or Google
  revoked the link — a password change or removing Athena in your Google
  account's "Third-party apps" page does that. Reconnect from the same row.
- **Connected, but I see nothing.** Almost always the wrong Google account was
  approved. Disconnect, reconnect, and check which account Google offers you on
  the sign-in screen.
- **I couldn't read it and I say so.** When the connection fails I'm given
  Google's own error, and I'll tell you what it said instead of guessing. If it
  repeats, there's a read-only server-side calendar diagnostic that checks
  whether the stored credential is live, whether the token still works, and
  whether the account actually has events — ask whoever runs your Athena to run
  it.

## Limits

- I can **add** an event if you approve it first — see the Actions panel. I
  still can't move, edit or cancel anything, or reply to an invite.
- Adding events needs a newer Google connection than reading does. If you
  linked your calendar before that existed, I can read it but not add to it
  until you reconnect it.
- I can only add to your primary calendar, and I can't invite anyone.
- Upcoming events and free/busy — not your calendar's full history.
- One Google account.
- I don't watch your calendar in the background. I look when you ask, so I
  can't warn you unprompted that a meeting starts in ten minutes.

## Under the hood

- Connector: `src/services/connectors/googleCalendar.js` — `matches()` keyword
  gate, calendar-list fan-out (capped at 20, 10-minute per-process cache),
  events + freeBusy.
- Descriptor: `google_calendar` in `src/services/connectors/registry.js`.
  `access_type=offline` + `prompt=consent` is the only reliable way to get a
  refresh token out of Google; `credentials.put()` preserves an existing one
  when a refresh response omits it.
- Grounding: `src/services/connectors/context.js`. Besides the keyword gate,
  `src/services/toolIntent.js` asks Jev (TypeSafe, hosted, ~0.2 s, adults
  only) which sources a message needs; a calendar only it picked is read with
  its window (`daysByProvider`, "tonight" → 1 day). Wired in
  `src/controllers/gemini.js` (`groundedFromGuess`), awaited just before the
  prompt. Key: `JEV_API_KEY` via `services/secrets`; no key → no guess.
- Diagnostic: `diagnose-calendar.js` at the `core_api` root — read-only, run
  with `node diagnose-calendar.js`.
- Writes: `createEvent` / `deleteEvent` in the same connector, called only
  from `src/services/actions` after a human approved the proposal — never
  from a context builder or tool loop. The descriptor requests
  `calendar.events` (read+write); a pre-existing link holds
  `calendar.events.readonly` and gets a typed `needs_reauth` on write rather
  than being torn down as a dead grant.
- Tests: `src/services/connectors/connectors.test.js`,
  `src/services/actions/actions.test.js`.

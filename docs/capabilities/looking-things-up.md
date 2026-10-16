---
id: looking-things-up
title: Looking things up before I answer
summary: When a question needs something I don't have in front of me — your calendar, the weather at your event, a web search — I look it up first instead of guessing.
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [weather, forecast, rain, cold, the game, the games, practice, tonight, tomorrow, check, look it up, what about, which one, the weather for]
---

## What I can do

Before I answer, I can go and get what I need. If you ask "what's the weather
looking like for the games today?", I check your calendar first, find the
game and where it is, then get the forecast for that field at that time, and
answer about your game, not someone else's.

What I can look up mid-answer:

- **Your calendar** — today, tomorrow, this week or the next month, or
  specific dates up to three years ahead (about two months per lookup) for
  planning a trip or anything further off.
- **Your email, WHOOP and live heart rate**, if you've connected them.
- **The weather at a place and time**, up to about a week out: your home, or
  wherever an event is. It comes from the US National Weather Service.
- **A web search I write myself**, once I know what you mean.

Your own world comes first. If "the game" could be on your calendar, I look
there before I search the web, and if the web is about a different game than
yours, I go with yours or ask which you mean.

In voice I'll say "let me check" while I look. It usually adds a second or two.

## Where to find it

Nothing to switch on. Ask the way you normally would. The calendar, email and
WHOOP need to be connected under **⋯ menu** → **Connected apps**; weather at
home needs **Home** saved on the **Community** page.

## When it doesn't work

- **I said I couldn't get the weather.** Either the place isn't on the map
  under the name your calendar uses (add the address to the event), it's more
  than a week out, or it's outside the US.
- **I answered about the wrong thing anyway.** Tell me which you meant; I'll
  look again.
- **I said a search wasn't sent.** My search would have named a person or
  something private, so I held it back. Ask me to search for the place or
  topic instead.

## Limits

- **I look things up, I don't change them.** Reading only.
- **Two rounds at most** before I answer, so I don't keep you waiting. If I
  still don't have it, I say what I couldn't get.
- **My web searches never carry anything private:** no family names, nothing
  about health, nothing from your email or messages. Places, times,
  businesses and public names only.
- **Weather is US-only** and about a week ahead at most.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Backend: `src/services/needs.js` (sources, `available`, `clean`, `fetch`,
  `mayLeave` query screen), `src/services/needsSchema.js` (the `needs` schema,
  kept apart so `prompt.js` doesn't load connectors).
- Loop: `src/controllers/gemini.js` — `MAX_NEED_ROUNDS` (2) and
  `NEED_BUDGET_MS`; the write after the last round gets the "no more lookups"
  block; later rewrites (monologue, action repair) also get it via
  `lookupsOpen`. Read blocks are appended to `integrationContext`.
- Guessed web pre-search is off for adults with a profile (`selfServe`); the
  keyword gate's explicit "look it up" still searches the raw message.
- Prompt: `needsBlock` replaces "# No lookups mid-reply" in
  `src/controllers/prompt.js`.
- Weather: `src/services/weather.js` `forecast(lat, lon, { hours, from })`
  now caches the week of hourly periods per point; places via
  `src/services/travel.js` `locate()` (Places Text Search near home) and
  `homeOf()`.
- Query rule (owner, 2026-10-10): places, times, public names yes; family
  names, health, email/message contents never. Children's first names are
  refused in code; the rest is a Jev screen that fails closed.
- Web block trust wording: `src/services/webSearch.js` `formatBlock`.
- Tests: `src/services/needs.test.js`, `src/controllers/needsLoop.test.js`,
  `src/services/weather.test.js`.
- Notes: `status: partial` until the loop has run against live models — the
  local tier may not fill `needs` reliably.

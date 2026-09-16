---
id: connected-apps
title: Connected apps
summary: I can link to outside accounts you own — calendar, fitness, family apps — and read from them when they're relevant.
where: the ⋯ menu in the top right → Connected apps
status: live
surfaces: [companion]
audiences: [adult]
triggers: [connect, connected, connection, link, linked, unlink, disconnect, integration, integrations, oauth, authorize, reconnect, sync]
---

## What I can do

I can link to accounts you already have and read from them during our
conversation — so "what's on tomorrow?" gets a real answer instead of a guess.
Right now that's **Google Calendar**, **Strava** and **Whoop**. Family Chores
links differently (from the Family Chores side).

Three things are always true of a connected app:

- **I only read.** I never create, edit, or delete anything in your accounts.
- **I only look when it's relevant.** A message about dinner never touches
  Strava. I check an app when what you said is plausibly about it.
- **You can cut it off at any time.** Disconnecting deletes the stored
  credential outright.

Your credentials are encrypted at rest and never appear in our conversation.

## Where to find it

The **⋯ menu in the top right corner** → **Connected apps**. Each app has its
own row showing whether it's connected, with a **Connect** or **Disconnect**
button.

Connecting sends you to that company's own sign-in page to approve it — I never
see or ask for your password. Strava and Whoop are health data, so the first
time you'll be asked to agree to that separately before the sign-in opens.

## When it doesn't work

- **"Not connected" when you know you connected it.** The link was probably
  revoked at the other end — changing a password or removing access in your
  Google or Strava account settings kills it. Reconnect from the same panel.
- **It connected, but I still can't see anything.** Usually the account you
  approved isn't the one holding the data. Disconnect, reconnect, and watch
  which account the sign-in page offers.
- **I say something went wrong and name the reason.** When a linked app fails,
  I'm handed the provider's actual error, and I'll tell you what it said rather
  than inventing a reason. If it keeps happening, that wording is the useful
  thing to pass on to whoever runs your Athena — there are server-side
  diagnostics for these connectors that can see more than I can from here.

I will never quietly pretend an empty schedule when the truth is I couldn't
reach your calendar.

## Limits

- Read-only. I can't add an event, start an activity, or change a setting.
- One account per app.
- Only the three apps above, plus Family Chores. Anything else isn't built yet.
- This panel is the Companion app only — the Guardians console has no
  connected apps.

## Under the hood

- Panel: `../../../companion/src/components/IntegrationsPanel.tsx`, opened from
  the `⋯` menu in `../../../companion/src/pages/CompanionConsole.tsx`.
- Provider descriptors (endpoints, scopes, consent, PKCE):
  `src/services/connectors/registry.js`. Adding a provider is a descriptor,
  not a code path — **and a capability file here; the test enforces it.**
- Generic OAuth dance: `src/services/connectors/oauth.js`. Credential storage
  and encryption: `src/services/credentials.js`.
- Per-turn grounding and failure reporting:
  `src/services/connectors/context.js` (keyword gate → snapshot → prompt
  block). Adults get the provider's real error text; children get "I can't see
  it right now" — `providerDetail` is scrubbed of anything credential-shaped.
- Routes: `GET /api/v1/integrations`, `POST /api/v1/integrations/:provider/connect`,
  `DELETE /api/v1/integrations/:provider`.
- Tests: `src/services/connectors/connectors.test.js`, `oauth.test.js`.

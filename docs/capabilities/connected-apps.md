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
Right now that's **Google** (Gmail, Calendar and Contacts), **Strava**,
**Whoop**, **Jira** and **Slack**. Family Chores links differently (from the
Family Chores side).

Signing in with Google also asks, on one Google screen, for Gmail, Calendar
and Contacts — so those links are renewed every time you sign in. Anything
you untick there can be turned on later from the Google card.

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
button. Gmail, Calendar and Contacts sit together on one **Google** card:
**Connect all** asks for all three at once, each service's own row connects
(or turns off) just that one, and **Disconnect all** withdraws Google's
approval entirely.

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

- Read-only, except what you approve one proposal at a time in the Actions
  panel (adding a calendar event, labelling mail).
- One account per app. Gmail may be a different Google account from the one
  you sign in with; signing in never switches it.
- Only the apps above, plus Family Chores. Anything else isn't built yet.
- On the Android app, signing in doesn't ask for the Google services — connect
  them from this panel.
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
- Provider groups (`GROUPS` in the registry): `google` = gmail +
  google_calendar + google_contacts. One consent (`beginGroup`), one code
  exchange, one credential per granted member (`completeGroup`); a member
  whose live link is on another account is kept, not swapped. A single member's
  disconnect skips the upstream revoke while a sibling is linked (Google's
  revoke kills the whole grant). It returns through the already-registered
  `/integrations/google_calendar/callback` (`callbackVia`), which hands a
  state issued for the group to `completeGroup` (`oauth.stateProvider`).
- Sign-in hand-off: `../../../companion/src/auth/AuthContext.tsx` starts the
  `google` group flow after a web sign-in (not Android), returning with
  `?from=signin`; the console only opens this panel if something was declined
  or kept.
- Per-turn grounding and failure reporting:
  `src/services/connectors/context.js` (keyword gate → snapshot → prompt
  block). Adults get the provider's real error text; children get "I can't see
  it right now" — `providerDetail` is scrubbed of anything credential-shaped.
- Routes: `GET /api/v1/integrations`, `POST /api/v1/integrations/:provider/connect`,
  `DELETE /api/v1/integrations/:provider`.
- Tests: `src/services/connectors/connectors.test.js`, `oauth.test.js`.

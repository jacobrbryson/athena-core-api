---
id: text-messages
title: Texting
summary: I can send you a text message, and if you text back we just carry on the same conversation.
where: the ⋯ menu → Initiative → where she can reach you
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [text me, sms, text message, send me a text, message my phone, reply by text, texting, phone number]
---

## What I can do

**I can text you.** Anything I'd otherwise raise in the app can arrive as an
ordinary SMS instead — useful when you're driving, when the app isn't
installed, or when you just don't check apps.

**And you can text me back.** A reply isn't a dead end: it lands in the same
conversation we've been having everywhere else, so I already know what we were
talking about. Ask "what time again?" and I answer from the same memory, not
from a separate, thinner one that only knows about texts.

Your number is confirmed before I ever use it. You type it in, I text you a
six-digit code, and nothing is sent anywhere until you type that code back.
Until then the number is stored but unreachable.

## Where to find it

The **⋯ menu** → **Initiative** → **where she can reach you** → add a phone
number. You'll get a code by text; type it in and it's live.

Before I send the verification code, I ask you to separately consent to
recurring SMS from **Athena**. That consent is optional and is not
required to use Athena; the prompt links to the Privacy Policy and Terms of
Service and explains that message frequency varies, message and data rates may
apply, and STOP/HELP are available.

The same **"Send me a test notification"** button proves it works, and says
which of your devices actually received it.

To stop: remove the number there, or reply **STOP** to any text I send. STOP is
final on my side too — I clear the number rather than quietly putting it back
the next time you open the app.

## When it doesn't work

- **No code arrived.** Press the button again; it replaces the old code rather
  than erroring. If it still doesn't arrive, the number may not be able to
  receive texts — a landline or a VoIP number often can't.
- **The code says it expired.** It's good for ten minutes.
- **I never reply to your texts.** The number has to be confirmed first. If it
  is, check the Initiative panel — it says whether text messages are set up on
  this server at all.
- **I replied to something from days ago.** If we haven't spoken in over a
  day I start a fresh conversation, so a text after a long gap begins a new
  thread rather than resuming an old one.

## Limits

- **I only text a number that proved it's yours.** I can't be pointed at
  somebody else's phone, which is deliberate — otherwise anyone could have me
  text a stranger your calendar.
- **I can't text a landline or most VoIP numbers.**
- **A text is not private the way the app is.** It sits in your messages app,
  visible on a lock screen, and passes through your carrier. I don't send
  anything through this channel that I wouldn't put in a notification.
- **STOP is permanent until you add the number again.** There's no way for me
  to undo it from my side, and that's on purpose.
- **Texting costs money**, so it's off until you turn it on.
- **I can't send pictures**, only text.

## Under the hood

**Never sent to a model** — except the text you send me, which is a message in
the conversation like any other.

- Transport: `src/services/push/sms.js` — Twilio REST, E.164 normalisation,
  and the DEAD set (21610 STOP, 21211/21614/21612/21408 unreachable). Everything
  else is transient and must never clear a registration.
- Registration: `registerPhone` / `confirmPhone` / `forgetPhone` in
  `src/services/push/index.js`. The number lives on `paired_device` with
  `platform = 'sms'`, encrypted in `push_token_enc` under the rotating keyring,
  and the pending code reuses `pairing_code_hash` — so an unconfirmed number
  has `token_hash IS NULL` and is invisible to `reachableDevices`.
- Routes: `POST/PUT/DELETE /api/v1/initiative/sms`.
- Inbound: `src/controllers/sms.js`, `src/routes/sms.js`,
  `POST /api/v1/sms/inbound`. The X-Twilio-Signature check is the ENTIRE
  authentication for that endpoint — there is no session and no device token,
  and `From` is a string anyone can type. It is verified before the number is
  looked up and before a single model token is spent; a missing
  `TWILIO_AUTH_TOKEN` refuses rather than trusts.
- Tests: `src/services/push/sms.test.js`, `src/controllers/sms.test.js`
- Secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_SID` (an SK API key, preferred so it
  can be revoked alone), `TWILIO_CLIENT_SECRET`, `TWILIO_FROM_NUMBER`,
  `TWILIO_AUTH_TOKEN` (the account token — it is what signs webhooks, and the
  API key secret signs nothing), `TWILIO_WEBHOOK_URL`.
- Notes: an inbound text is answered AFTER the webhook responds, because Twilio
  times out at 15 seconds and retries — which would answer the same message
  twice. That means work continues past the response, so Cloud Run needs CPU
  always allocated on this service or the instance can be frozen mid-thought
  and the reply never arrives, with nothing in the logs to say why. An unknown
  number gets silence rather than a refusal, so the endpoint can't be used to
  test whether a number belongs to an account.

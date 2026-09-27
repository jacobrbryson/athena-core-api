---
id: google-contacts
title: Google Contacts
summary: I read your Google Contacts (read-only) and overnight link numbers, emails, birthdays and photos to the people I know.
where: the ⋯ menu (top right) → Connected apps → Google → Contacts → Connect (or approve it when you sign in)
status: live
surfaces: [companion]
audiences: [adult]
triggers: [contacts, contact, google contacts, address book, phone number, phone numbers, email address, birthday, birthdays, profile picture, photo of]
---

## What I can do

With Google Contacts connected I can read your address book — names,
nicknames, phone numbers, email addresses, the relationships you've recorded
("spouse", "mother"), birthdays, addresses, workplaces and profile pictures.

I don't flip through it while we talk. Each night, while I dream, I compare
your contacts with the people you've told me about and link them up: your
sister's entry gets her phone number, birthday and photo; someone I only know
from your contacts can become someone I know. When a match is likely but not
certain, I'll ask you rather than guess. After that, "what's Emma's number?"
or "when is Dad's birthday?" can be answered from what I've organized.

It is read-only. I can't add, change, or delete a contact.

## Where to find it

When you sign in with Google, Google's approval screen asks for Gmail,
Calendar and Contacts together. Leave Contacts ticked and it's connected.

If you unticked it, the **⋯ menu in the top right corner** → **Connected
apps** → the **Google** card → the **Contacts** row → **Connect**. Google asks
you to approve contacts access, and it's added to the approval you already gave.

To turn it off, the same row has **Off**. That deletes my copy of the access,
and by the next morning everything I'd linked from your contacts is gone too.

## When it doesn't work

- **I don't know a number you know is in your contacts.** I link contacts
  overnight, so something added today shows up tomorrow. It also only lands
  once I've matched the contact to someone — if I asked you a question about
  who someone is, answering it helps.
- **The Contacts row says reconnect.** Google withdrew the approval (a
  password change, or removing Athena in your Google account's third-party
  access page). Connect it again from the same row.
- **The wrong people show up.** You approved a different Google account than
  the one holding your contacts. Turn Contacts off and connect it again,
  choosing the right account.

## Limits

- Read-only — no creating, editing or deleting contacts.
- Your own contacts only: not "other contacts" Gmail saved automatically, and
  not a company directory.
- Updated once a night, not live.
- One Google account.
- Contacts are never read for a child, and never shared with anyone else's
  memories.

## Under the hood

- Connector: `src/services/connectors/googleContacts.js` — People API
  `people/me/connections`, paged, capped at 5000; `normalize()` flattens a
  person to the mirror's shape. Returns null only when nothing is linked
  (reason `absent`); any other failure throws so a bad night can't read as a
  withdrawal.
- Descriptor: `google_contacts` in `src/services/connectors/registry.js`
  (`contacts.readonly` + `openid email`), a member of the `google` group with
  `gmail` and `google_calendar`. Group consent: `beginGroup` / `completeGroup`
  / `disconnectGroup` in `src/services/connectors/oauth.js`, routed from
  `src/controllers/connectors.js` (`/integrations/google/connect`,
  returning through `/integrations/google_calendar/callback`,
  `DELETE /integrations/google`).
- Dreams: `src/services/dreams/dream.js` reads contacts for adults with an
  active link and mirrors them into the code-owned `_contact` table
  (`src/services/dreams/mind.js`). Rows she builds cite `c:<contact_id>`; the
  purge deletes any row whose contact is gone for that same person. A profile
  whose read failed keeps last night's mirror.
- Sign-in hand-off: `../../../companion/src/auth/AuthContext.tsx`
  (`handOffToGoogleConsent`), card in
  `../../../companion/src/components/IntegrationsPanel.tsx`.
- Tests: `src/services/connectors/oauth.test.js` (google group),
  `src/services/dreams/dreams.test.js` (contacts mirror).

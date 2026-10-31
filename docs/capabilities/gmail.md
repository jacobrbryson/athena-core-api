---
id: gmail
title: Gmail
summary: I sort your inbox and propose bundles — archive, unsubscribe, file receipts, add events — and draft replies, acting only when you approve.
where: approve it when you sign in with Google, or ⋯ menu → Connected apps → Google → Gmail → Connect; then System → Mail
status: live
surfaces: [companion]
audiences: [adult]
triggers: [gmail, email, emails, inbox, mail, receipts, unread, scan more, triage, sort my mail, archive, promos, newsletters, needs reply, clean up my inbox, unsubscribe, draft a reply, reply to]
---

## What I can do

I sort your inbox into receipts, travel bookings, school announcements,
emails where someone is **asking you something**, promos, automated updates,
FYIs and everything else. The Mail card and the **Athena proposes** panel on
the Mail page turn that into bundles, so one approval clears many emails:

- **Archive promos and updates** — out of the inbox, still in All Mail and
  Gmail search. Nothing is deleted.
- **File receipts** — labelled "Receipts" and logged to your spending. You can
  see every receipt you've filed under **Family → Finance → Receipts**: date,
  merchant, category, amount and the email's subject, with each month's total
  per currency. It's a read-only list, and a receipt with no amount is listed
  as "not found" rather than guessed.
- **Unsubscribe** from senders whose promos keep piling up (three or more
  waiting) and who offer a one-click unsubscribe — then archive what they sent.
  This is the one bundle that can't be undone from here.
- **Add events** from travel and school emails where I found a date — up to
  10 per approval, each listed with its date and time so you can catch a
  wrong one. I check your calendars first: an event whose date has already
  passed, or that's already on a calendar under the same name that day (a
  Google Calendar notification email, say), isn't offered. Emails with no
  date aren't in the bundle; open one from the dashboard's Mail card to type
  the date in.
- **Needs you** — on the dashboard's Mail card, who is waiting on a reply
  and what they're asking for. Open one and press **Draft a reply**: I write a first draft you can edit,
  with anything only you know left in [brackets], and saving puts it in
  Gmail's Drafts in the same thread. I never send it — you do, from Gmail.

The Mail page opens with an **Inbox Assistant** header: how many suggestions I
found, when I last read your inbox, and how many emails are waiting to be
sorted, with the **Scan more** button right there.
Under it all four bundles always show, side by side, so one with nothing in it
says so instead of disappearing. Each bundle is its own card with its emails
listed — sender, date, subject, and for receipts the amount — plus a
**Reversible** or **Not reversible** badge, a "selected of" count with Select
all, and a button that names exactly what it will do ("Archive 3 emails").
Unsubscribe is red and says plainly that it can't be undone. Below the cards,
**Recent activity** lists the mail actions you've approved, ten to a page with
Previous and Next — what, when, and whether it can be undone. An archive has an **Undo** button: it shows a card
saying how many emails I'll move back to the inbox, and nothing moves until you
approve it. Once it's done the row says Undone. Receipts, calendar events and
unsubscribes have no Undo button here yet; unsubscribing can't be reversed at all.

Pressing a bundle shows exactly what I'll do, and nothing changes in Gmail
until you press Approve. On the Mail page, untick any email in a bundle
first. On the dashboard's Mail card, any single email can also be archived, filed, moved to
Trash or hidden from the list from its own view.

I check Gmail for new mail whenever you open the dashboard (if I haven't in
five minutes), but I only sort it when you press **Scan more** on the Mail
page. Until then new mail shows as **Sorting…** and doesn't appear in any
bundle. **Scan more** sorts the mail still waiting first, newest first, then
reaches into your older mail. If you archive, delete or read-and-file
something in the Gmail app, it drops off my list too.

## Where to find it

Signing in with Google asks for Gmail along with Calendar and Contacts on one
Google screen; leave it ticked and it's linked to the account you signed in
with. To connect it separately, or to use a different account, open Connected
apps from the ⋯ menu, find the Google card, and press Connect on the Gmail row.
Then open **System** in the left navigation and choose the **Mail** tab, or tap
the Mail card on the dashboard. The Mail page is the four bundles and the
activity list; the dashboard card is where you open a single email.

## When it doesn't work

- **Bundles are empty and the inbox says "Sorting…".** Nothing sorts new mail
  on its own; press Scan more on the Mail page to sort it.
- **Filing or Trash fails with "reconnect".** Accounts linked before I could
  file mail only gave me read access; reconnect Gmail in Connected apps and
  approve the new permission.
- **Needs authorization.** Reconnect it in Connected apps. A failed read is
  shown as unavailable, never as an empty inbox.

## Limits

- **Shipping notices get one more read.** For a shipping or delivery email I
  note the order's state — shipped, out for delivery, delivered — so I can
  match it to a package on the door camera ([packages.md](packages.md)). I
  don't track the package with the carrier.

- I never send email — replies are saved as Gmail drafts for you to send —
  and nothing moves, gets labeled, trashed, unsubscribed or logged without
  your approval of that specific card.
- Unsubscribe only works for senders that support one-click unsubscribe; a
  link that would mean sending an email, or that points anywhere unusual, is
  never used. Once done, it can't be undone from here.
- One approval covers at most 100 emails to archive, 25 receipts, 10 events
  or 10 senders;
  the rest come up in the next bundle.
- I sort mail only when you press Scan more; there is no scheduled sorting.
- One connected mailbox.

## Under the hood

- Triage: `../../src/services/emailTriage.js` (classify → extract → `email_triage`; `pending` rows from sync; Scan more sorts pending first)
- Sync: `../../src/services/emailSync.js` (Gmail history from `email_sync_state.history_id`; `gone` status when a message leaves the inbox; 404 cursor → bootstrap reconcile; daily reconcile backstop) — design in `../architecture/mail-card.md`
- Job: `../../src/jobs/mail.js`, scheduled by `../../../deploy/scripts/setup-mail-sync.sh` (every 15 min, per-profile access context); migration `../../db/migrations/0049_email_sync.up.sql`
- Receipts list: `../../src/services/receiptLedger.js` (read-only, scoped to the caller), `GET /dashboard/email/receipts` (`receipts` in `../../src/controllers/email.js`), `../../../companion/src/components/FamilyReceipts.tsx` on Family → Finance. Test: `../../src/services/receiptLedger.test.js`
- Reads/writes: `../../src/services/connectors/gmail.js` (`archiveMessages` = batchModify remove INBOX); actions `archive_emails` (phase 2, 1-100, reversible), `add_email_events` (phase 3, 1-10, each item through `file_travel_or_school_email`'s normalize), `unsubscribe_senders` (phase 4, irreversible, link read from the stored row, never params), `draft_reply` (phase 5, `users.drafts.create`, covered by `gmail.modify`; no send path exists) — none standing-approvable, `file_receipt_email`, `file_travel_or_school_email`, `delete_email`, `dismiss_email` in `../../src/services/actions/registry.js`
- Bundles: `emailTriage.bundles()` — archive = open `promo` + `notification`; categories also `needs_reply` (with a model-written `ask`, display only) and `fyi`; old `other` rows are re-sorted 50 per job pass (`resortOld`)
- Unsubscribe: `../../src/services/unsubscribe.js` (RFC 8058 one-click https only; public-address check before the request; fixed body, no redirects, 10 s). Drafts: `../../src/services/emailDraft.js` (model writes editable text; `replyMime` strips CR/LF from copied headers)
- Undo (owner-authorized 2026-10-28): action `unarchive_emails` (never standing; `normalize()` only accepts rows still `archived` under the caller's profile; `execute()` adds INBOX back and sets them `new`), `gmail.unarchiveMessages`, `POST /dashboard/email/undo-archive` (`proposeUndoArchive` reads the emails from the recorded archive action, never the request), `../../../companion/src/components/MailActivity.tsx`. Tests: `../../src/services/actions/unarchiveEmails.test.js`, `../../src/controllers/email.undo.test.js`
- API: `../../src/controllers/email.js`; dashboard card: `../../src/services/dashboard.js` (syncs first when stale)
- OAuth: `../../src/services/connectors/registry.js`, `../../src/services/connectors/oauth.js`
- Frontend: `../../../companion/src/components/MailBundles.tsx`, `../../../companion/src/components/Dashboard.tsx`, `../../../companion/src/components/EmailPanel.tsx`
- Tests: `../../src/services/actions/archiveEmails.test.js`, `../../src/services/actions/addEmailEvents.test.js`, `../../src/services/actions/unsubscribeSenders.test.js`, `../../src/services/actions/draftReply.test.js`, `../../src/services/unsubscribe.test.js`, `../../src/services/emailDraft.test.js`, `../../src/services/emailSync.test.js`, `../../src/services/emailTriage.test.js`, `../../src/services/connectors/work.test.js`

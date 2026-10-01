# Mail card — design (2026-09-30)

Status: phases 1–5 built 2026-09-30 (3: `add_email_events`; 4: `unsubscribe_senders`
+ `src/services/unsubscribe.js`; 5: `draft_reply` + `src/services/emailDraft.js`).
Phase 5 needed no new consent after all: `gmail.modify`, already granted for
filing, covers `users.drafts.create`. Unsubscribe uses "3+ promos/updates
waiting" rather than "never opened" — read state isn't tracked. Draft time is
counted per saved draft, not per sent reply (sending isn't visible to Athena).
Earlier: phases 1 and 2 built 2026-09-30. Phase 1: `src/services/emailSync.js`,
`src/jobs/mail.js`, migration 0049. Phase 2: new categories, `emailTriage.bundles()`,
`archive_emails` (owner signed off), `MailBundles.tsx`. The receipts bundle reuses
the existing grouped `file_receipt_email`. Owner decisions: auto-sort new mail
yes; promos archive, not Trash; phases 3–5 signed off 2026-09-30.

One departure from the sketch below: pressing a bundle proposes it and the
standard proposal card asks for Approve — two taps, not one — because every
action that writes to Gmail stops for a real approval.

The goal is a Mail card that makes the inbox faster to clear than the Gmail
app, measured by Time saved on the System page. The Gmail app is quick at one
message at a time. Athena only wins by making **many decisions in one tap** and
by doing the part Gmail can't: pulling the event out, filing the receipt,
drafting the reply. So the card stops showing a preview of mail and shows
**what Athena proposes to do**, grouped into bundles you approve whole.

## Why it is stale today

1. **Nothing scans unless you press "Scan more."** `emailTriage.scanNext` is
   on-demand only. That was chosen so the 2,000-email backlog could be worked
   through at your pace, but it also means new mail never arrives by itself.
2. **Rows never find out that you dealt with a message in Gmail.** Archive,
   read or delete something on your phone and its `email_triage` row stays
   `new` forever. The card keeps showing mail that is already gone.
3. The preview is ordered by `id DESC` (scan order), not by when the mail
   arrived.

## Card, as it would read

```
MAIL                                      Inbox 1,842 · 37 since 7 AM
──────────────────────────────────────────────────────────────────
Archive 31 promos and newsletters you haven't opened   [Approve] ›
Add 2 events: Ashlynn → NYC Thu · Picture day Fri       [Approve] ›
File 6 receipts (Amazon ×3, Duke Energy, …)             [Approve] ›
Unsubscribe from 4 senders you never open               [Review]  ›
Needs you · 3
  Shawn: "Can you send the Troutman roster?"            [Draft]   ›
  …
──────────────────────────────────────────────────────────────────
Saved you 14 min this week
```

- Each bundle is a single proposed action covering a list of messages.
  **Approve** runs it. **›** opens the list with a checkbox on every message,
  so you can leave some out before approving.
- The card shows only bundles that have something in them. When nothing is
  left: "Inbox handled — nothing needs you." The card still shows, following
  the rule that cards never hide.
- The Mail page is the card at full size, plus the backlog meter: "1,204 older
  emails not sorted yet · Sort 100 more." Pacing the backlog stays manual.

## Pieces

### 1. Stay in sync (fixes the staleness)

- Store Gmail's `historyId` per profile. Each pass calls
  `users.history.list?startHistoryId=…&labelId=INBOX`. That is one cheap call,
  and it returns both new mail and mail that left the inbox.
- New inbox messages are triaged automatically, at most 50 per pass. The
  backlog (mail older than the first sync) stays on "Sort more."
- Messages that left the inbox or were deleted become `status = 'gone'` and
  drop out of every bundle. Whatever you do in the Gmail app, the card follows.
- If the `historyId` is too old (404), fall back to one listing of the inbox
  and reconcile against it.
- When a pass runs: when the dashboard loads (if the last pass is more than
  5 minutes old), and every 15 minutes from the existing every-minute worker
  (`src/jobs/attention.js` pattern). Gmail push through Pub/Sub can replace the
  polling later without changing anything else.
- History reads must **not** go through the read cache, because staleness is
  the complaint. They are not in `CACHEABLE_READS`, so they are already
  excluded.

### 2. Sort into what can be acted on

Extend the current cheap bulk classifier (receipt / travel / school / other)
to these categories: `promo` (marketing and newsletters), `notification`
(automated updates and alerts), `needs_reply` (a person asking you
something), `fyi` (personal, nothing to do), plus the existing three. The model
only labels. Code decides the bundles, using signals Gmail gives for free:

- Gmail's own `CATEGORY_PROMOTIONS` / `CATEGORY_UPDATES` labels
- a `List-Unsubscribe` header
- **senders you never open:** everything from that sender in the inbox is
  still `UNREAD` after 7 days, and there are at least 3 such messages

`needs_reply` extraction adds one line describing what is being asked, taken
from the message text. That line is display only and never treated as an
instruction (the same rule as `rationale` today).

### 3. New actions (protected — each needs your sign-off)

All of them go through the existing propose → approve → audit sequence. A
bundle is one `athena_action` row whose parameters list message uuids. Its
`normalize()` checks that every uuid belongs to the caller and is still
`new`, and caps the list at 100.

| Action | Does | Reversible | Standing approval | Scope |
| --- | --- | --- | --- | --- |
| `archive_emails` | removes the INBOX label from N messages | yes (add INBOX back) | allowed later, only if you grant it | `gmail.modify` (have it) |
| `file_receipts` | bundle form of `file_receipt_email` | label yes; receipt ledger row stays | no | have it |
| `add_email_events` | bundle form of `file_travel_or_school_email` | event yes | no | have it |
| `unsubscribe_senders` | RFC 8058 one-click unsubscribe, then archives that sender's inbox mail | **no** | never | none (an HTTP POST) |
| `draft_reply` | creates a Gmail draft in the thread; **never sends** | yes (delete the draft) | no | `gmail.compose` (new consent) |

Guarding unsubscribe: the link comes from an email header, so it is untrusted.
Athena acts on it only when the message carries
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` and the link is `https`.
The request uses the fixed RFC body, with no cookies, no redirects to other
hosts, a 10-second timeout, and private/loopback addresses blocked (SSRF).
`mailto:` unsubscribe links would need Athena to send email, so they are left
for you to handle.

Time saved rates (added to `timeSaved.js`, low on purpose): archive
0.1 min per message; file a receipt 0.5 per message; add an event 2 per event;
unsubscribe 1 per sender (future mail you no longer receive is not counted);
draft a reply 2 per draft that you send yourself.

### 4. Where the time actually comes from

Most of the saving is archive bundles and events. Unsubscribe shrinks
tomorrow's inbox. Drafts are the largest per-item saving, but they need a new
Google consent and a model writing in your voice, so they come last.

## Phases

1. **Sync and reconcile, plus arrival order.** Small, touches nothing
   protected, and fixes "outdated" by itself.
2. **Categories, bundles, `archive_emails`, and the new card.** The big one.
3. **`file_receipts` / `add_email_events` bundles.**
4. **`unsubscribe_senders`.**
5. **`needs_reply` and `draft_reply`** (Google re-consent for `gmail.compose`).
6. Later, and only if you want: standing approval for archive bundles, and
   Gmail filters (a persistent rule, so an explicit yes each time).

## Decisions for the owner

1. **Auto-triage new mail?** This partly reverses the on-demand-only decision:
   new mail would be sorted automatically, and the backlog stays manual.
2. **Archive or Trash for promos?** Recommended: archive. It's reversible, and
   Gmail search still finds the message.
3. **Approve the new action types** (phases 2–5). They are protected code and
   ship only on your say-so.
4. **Re-consent Google for `gmail.compose`** when phase 5 arrives.

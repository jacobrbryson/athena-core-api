# Athena's agenda — design (2026-10-01)

Status: **design only, waiting for owner sign-off.** Nothing is built.

The goal is "What's this?" → "That." Athena should notice what she doesn't
know, ask about it once at a good moment in a conversation you started, and
have tomorrow already thought through before you open the app. Four pieces,
one feature: dreaming finds gaps, dreaming writes a brief, she asks in chat,
and the Family card is ranked from the brief instead of listing memories.

## Why the Family card reads the way it does today

"Ashlynn, Skylar, Thomas, Jenny, Missy, Lora" is not a ranking. It is:

1. `GET /api/v1/memory` → `memory.listOwnMemory`, which sorts
   `ORDER BY category ASC, updated_at DESC`.
2. `Dashboard.tsx:712` keeps the categories `person | family | pet`.
3. The card shows the first three, titled by `memory_key`.

So the order is the category name alphabetically (`family`, then `person`,
then `pet`), and inside each, whichever fact was written or re-written most
recently. A nightly consolidation that touches a row moves that person up.
Nothing about health, the calendar or how close someone is enters it, and a
person with three facts appears three times.

## Card, as it would read

```
FAMILY                                                          1
──────────────────────────────────────────────────────────────────
Thomas     has a cold · day 2, mild                 [Feeling better?]
Ashlynn    NYC trip · Thursday, in 3 days
Jenny      birthday Sunday
Skylar     you mentioned her yesterday
──────────────────────────────────────────────────────────────────
I know your family well — still curious about Wynter's vet.
Google Contacts isn't linked — birthdays and phone numbers
come from there.                                        [Connect] ›
Family Chores · today   ○ Dishes   ✓ Trash
```

- One row per person or pet, never one row per fact.
- Every row carries its reason. A row with no reason is not shown on the
  card; it lives on the Family page under "Everyone else".
- The card never hides. With nothing known it keeps today's "Tell her about
  them" button; with Contacts unlinked it carries Connect.

## Pieces

### 1. The roster — who the card is about

Ranking needs one row per person, and her tables in `athena_mind` have
whatever shape she chose. So the dream is asked to keep one table of a
**fixed shape**, `family_roster`: `_profile_id`, `_sources`, `name`, `kind`
(`person | pet`), `relation` (from a fixed list: spouse, partner, child,
parent, sibling, grandparent, grandchild, pet, other_family, friend),
`is_minor`, `contact_id`.

It is her table, written through the existing `upsert` op, so nothing new is
needed for safety: sources are checked per row, the purge reaches it, and the
guard drops it if it loses its two columns. The code reads it with a
code-built query (`WHERE _profile_id = ?`) and only if every expected column
is present. If it is missing or malformed the card falls back to grouping
`person | family | pet` facts by name — worse, but never empty because of a
bad night.

### 2. The brief — tomorrow, prepared

A nightly step after the dream (`src/services/dreams/brief.js`) writes one
brief per adult covering the next 72 hours. Each item is
`{ person, kind, line, when, sources }`.

Candidates are built **in code**, the same rule as Right Now:

| Kind | Source | Example |
| --- | --- | --- |
| `health` | `family_health_status` (active) | Thomas has a cold, day 2 |
| `event` | Google Calendar, next 72 h, when linked | Ashlynn → NYC trip Thursday |
| `birthday` | `_contact.birthday`, next 14 days, when linked | Jenny's birthday Sunday |
| `mentioned` | newest `user_memory` fact about a roster person | you mentioned her yesterday |

An event is tied to a person in code when a roster name appears in its title.
The model is used for one thing only: an event that names nobody ("Flight
CLT → LGA") may be matched to a person using the facts ("Ashlynn's NYC trip
is Thursday"). It returns an event id and a roster name; anything that is not
an existing event id and an existing roster name is discarded. It cannot add
an item, a time or a person. With no model the brief is simply the code-built
items.

Readers:

- **Family card** — ranks from it (piece 4).
- **Chat** — a short "what's coming up for their people" block for adult
  sessions, so she can say "how's Thomas feeling?" without being told again.
  The person's own brief only, through a code-built query.
- **Right Now** — as a signal on existing candidates, not a new candidate
  type (phase 5, small).

Freshness: the brief stores the *link* (event id → person). The time shown
comes from the live calendar the dashboard already loads, so an event that
moved or was deleted during the day moves or disappears on the card. Health
rows are read live for the same reason; "Feeling better?" must take effect
at once, not tomorrow.

Forgetting: each item lists the fact ids it leaned on. At read time an item
whose facts no longer exist is dropped, so "forget that" works the same
minute, and the next night rewrites the brief anyway.

### 3. Gaps — the agenda

`src/services/dreams/expectations.js` is a plain list, in code, of what she
would expect to know:

| About | Expected | Weight |
| --- | --- | --- |
| a child | doctor, allergies, school, teacher, birthday | high → medium |
| a pet | vet, birthday or age, favourite things | medium → low |
| a spouse or partner | birthday, anniversary, workplace | medium |
| any adult family | birthday, how to reach them | low |
| the person themselves | their parents' names | low, **sensitive** |

The dream gets this list and a new op, `gap`:
`{ profile_id, subject, slot, question, why, about: [sources] }`. She decides
*whether* a slot is already answered by the facts, and words the question.
The code decides everything else: the subject must be on that person's
roster, the slot must be on the list, the sources must be that person's, and
the priority comes from the weight table — not from her.

Gaps are stored in `athena_dream_question`, not a second table (migration
0050 adds `kind` (`clarify | gap`), `subject`, `slot`, `reason`, `priority`,
and a unique key on profile + subject + slot). Differences from clarifying
questions:

- **No cap and no 14-day expiry for gaps.** The existing limit of 10 pending
  throws the eleventh away, which would silently drop true observations. A gap
  stays open until it is filled or declined. The limit of 10 stays for
  `clarify` as it is today.
- **Closed by the facts.** The night after you answer, memory extraction has
  already turned your reply into `user_memory` facts (it runs before the dream
  in `nightly.js`), the dream sees the slot is filled, and resolves the gap.
  There is no new write path into memory.
- **Declined is final.** "I'd rather not" closes that subject + slot for good.
  It is never re-asked and never counts against the family line below.
- **Sensitive slots are never asked cold.** A question about someone's
  parents is only offered in a conversation where they brought that person or
  topic up themselves.
- **Forgetting reaches questions.** Today a question survives the facts it
  was about. The nightly tidy will dismiss any pending question whose `about`
  sources are gone, so "forget Wynter" also removes "what are Wynter's
  favourite toys?".

Children: a gap about a child comes only from what an adult told her or put
on their own calendar. A child's own memories still never enter, and gap
questions are only ever offered in adult sessions.

### 4. Asking — in conversation, no forms

`recall.js` already puts pending questions in the chat prompt. The change is
targeting. Per turn, in code:

1. If the message names a subject with an open gap ("Wynter" → her vet,
   her toys), offer that one. This is the best moment there is.
2. Otherwise, if someone in today's brief has an open gap, offer that one.
3. Otherwise the highest-priority open gap or clarifying question, oldest
   first, with the existing "at a natural pause" instruction.
4. Nothing is offered when the same prompt carries an urgent nearby incident
   or a severe health status.

She is handed **one** question, with its reason ("you look after Wynter and I
don't know who her vet is"), not three to choose from. No settings screen, no
form field, no new endpoint that accepts an answer. The Dreams page already
lists your questions read-only; gaps appear there the same way.

### 5. Ranking the Family card — in code

`src/services/familyCard.js`, returned in the dashboard summary. Tiers, in
order; inside a tier, the rule on the right:

1. **Active health concern** — severe before mild, then longest-running.
2. **Event in the next 72 hours** — soonest first.
3. **Birthday within 14 days** — soonest first.
4. **Recently mentioned** (last 7 days) — most recent first.
5. Everyone else — Family page only.

A person in two tiers appears once, in the higher, with the second reason
appended. No model is involved. Source preference is built into the tiers:
health status and calendar outrank contacts, which outrank memories.

No Fitbit connector exists in `core_api` today, so "family health" means the
family health watch. If a family member's wearable is ever connected, it
enters tier 1 through the same row shape.

**"How well I know your family"** is one line under the rows:
filled ÷ (filled + open) expected slots, across the people you actually
have. Declined slots are left out of both sides. It is shown in words, never
as a percentage or a meter: "I'm just getting to know your family" /
"I know your family fairly well" / "I know your family well", followed by the
single thing she is most curious about. Because it is a ratio per person
known, a household of two can read "well" as easily as a household of eight.

**Contacts** joins the dashboard summary as a status-only source (a
credential check, no People API call per load), which gives the card the
standard Connect / Reconnect button through the existing `SourceBlock`.

## What this does not touch

- `core_api/src/security/`, access middleware, the action layer: untouched.
  Nothing here executes or proposes an action.
- `core_api/src/services/initiative/`: untouched. `questions.pendingFor`, which
  the `dream_question` trigger calls, will keep returning `clarify` questions
  only, so gap questions do **not** start arriving as push notifications as a
  side effect.
- Her grants, her connection, `user_memory` as the source of truth, the
  purge, and the Dreams log location are unchanged. The brief's one model call
  goes through the guarded `llm` adapter like every other.

## Phases

1. **Family card ranked from real sources.** `familyCard.js`, one row per
   person with a reason, Contacts Connect button, mock data, phone width. Uses
   health, calendar name-matching, contact birthdays and facts; no dream
   change, no migration. Fixes the order by itself.
2. **Roster and gaps.** Migration 0050, `expectations.js`, the `gap` op, the
   `family_roster` contract, forgetting reaches questions. Jest with mocks.
3. **Asking.** Targeting in `recall.js`; gaps on the Dreams page.
4. **The brief.** Migration 0051 (`athena_brief`), the nightly step, the chat
   block; the card switches from phase 1's live build to brief + live times.
5. **The family line, Right Now signal, System page count.**

Each phase ships its capability file change and a `LEDGER.md` line
(`companion-dashboard.md`, `dreaming.md`, and a new `agenda.md`). Migrations
0050 and 0051 run against production, so each waits for your go-ahead.

## Time saved

Recommendation: **do not feed it.** That figure counts approved actions
against a hand-done equivalent, and nothing here is approved or has one. A
guess at "minutes you didn't spend explaining" would not survive a skeptic.

What can be measured honestly is a count, shown beside Time saved and never
converted to minutes: **gaps closed this month** (questions answered) and
**brief items that came true** (an event or health row that was on the brief
and still existed when its day arrived). If you save an answer through
`remember_fact`, that already counts its existing 0.5 minutes.

## Decisions for the owner

1. **Questions per conversation.** Recommended: **one**, and a second only
   after the first was answered in that same conversation. Picked by the order
   in piece 4. This is a pacing limit you asked for, and it defers rather than
   discards: every unasked gap stays open with no expiry.
2. **Where the brief lives.** Recommended: **the main database**
   (`athena_brief`), written by code. It holds calendar data, which the
   `f: / q: / c:` source scheme cannot purge; the chat and dashboard read it on
   every load; and her model SQL should not be able to rewrite what the card
   shows. Calendar events would not enter `athena_mind` at all.
3. **What counts as family.** Recommended: roster rows whose relation is
   spouse, partner, child, parent, sibling, grandparent, grandchild or pet,
   plus anyone with an active health row. No surname matching — it would drop
   Jenny if she kept her name and add a stranger who shares yours. Friends and
   `other_family` appear on the Family page, not the card. Where a Google
   Contacts relation and a memory disagree, she asks (a `clarify` question)
   rather than choosing.
4. **A push trigger?** Recommended: **none now.** Gap questions are not
   urgent, and the calendar already reminds you about Thursday. If you want
   one later, the candidate is a single opt-in "tomorrow, for your people"
   trigger from the brief; I would propose it separately and you would enable
   it.
5. **Gaps: no cap, no expiry, declined is final** (piece 3). Confirm, since it
   changes how `athena_dream_question` behaves for the new kind.
6. **Asking about parents.** Recommended: only when you raise them. Say if
   you would rather she never asks.
7. **Migrations 0050 and 0051** against production, when their phases arrive.

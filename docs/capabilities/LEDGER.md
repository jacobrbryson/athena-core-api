# Capability ledger

Append-only record of what changed in Athena's user-visible capabilities.
**Newest first.** One line per change, in this shape:

```
- YYYY-MM-DD — <what changed, in plain language> — `capability-file.md` (status: live)
```

Rules:

- Every change that adds, removes, renames, or meaningfully alters something a
  person can see or ask about gets a line here, in the same commit as the code.
- Say what changed for the **person**, not what changed in the code. "Athena
  can now see events on shared calendars, not just the primary one" — not
  "added calendarList fan-out".
- Name every capability file you touched. If you didn't touch one, ask yourself
  why not; if the answer is "there isn't one", that's the missing work.
- Never edit or delete an existing line. A wrong entry gets a new line
  correcting it, dated today.
- A capability that is removed gets a final line saying so, and its file is
  deleted in the same commit — a stale file is a lie Athena will tell.

See [`README.md`](README.md) for the full contract.

---

## 2026

- 2026-09-18 — Fixed clipped navigation sprites and added consistent hover, press, and keyboard-focus feedback across Companion controls, with reduced-motion support — `companion-dashboard.md` (status: partial)

- 2026-09-18 — Two guardians can now share one conversation with Athena: when
  one signs in on the device the other was using, she carries on the same
  conversation instead of starting over, uses their names, and says who is
  taking part. Only adults in the same family can join, everyone in a shared
  conversation can read all of it including the part before they signed in, and
  if a child is present she stays on the child-safe settings for everyone —
  `shared-conversations.md` (status: partial)

- 2026-09-18 — Companion opens to a responsive Today dashboard with desktop sidebar, mobile navigation, saved family/work memories, editable chat shortcuts, connected-app status, and a compact briefing drawer; live summary feeds are not yet available — `companion-dashboard.md` (status: partial)

- 2026-09-18 — Athena can reach a paired phone: what she raises unprompted now
  arrives as a notification, so she no longer has to wait for the app to be
  opened. It is a separate switch from initiative itself, one notification at a
  time, and inside exactly the same limits. She also learns from how each one
  lands — asking her to stop sending something stops it immediately, and a kind
  of thing that keeps being waved away is quietly dropped, shown with its reason
  and a way to turn it back on — `initiative.md`, `devices.md`
  (status: partial)

- 2026-09-18 — Athena can start a conversation instead of only answering one:
  she says something when an event is about to begin, when two things on the
  calendar clash, or when a heavy day lands on a bad night's recovery. It is
  off until switched on, capped at three a day, silent overnight, and every
  rule can be muted on its own. Everything she raises is marked as hers in the
  conversation, and the new Initiative panel lists what she said and how each
  one landed — `initiative.md` (status: partial)

- 2026-09-17 — Athena can now offer to *do* things, not only say them: she
  proposes adding a calendar event or saving a fact, and it happens only when
  the person taps Approve on the card. Everything she has done, and everything
  she asked and was refused, is listed in the new Actions panel, where a person
  can also tell her to stop asking for one kind of thing. Google Calendar now
  asks for permission to add events, so an existing calendar link needs
  reconnecting before she can write to it — `actions.md`, `google-calendar.md`
  (status: partial)

- 2026-09-15 — Athena became aware of her own feature set: capability files now
  load into her system prompt per message, so she can say what she can do and
  point to the menu that turns it on instead of guessing — `README.md`,
  `_template.md`, and the initial catalog: `connected-apps.md`,
  `google-calendar.md`, `strava.md`, `whoop.md`, `family-chores.md`,
  `memories.md`, `photos.md`, `devices.md`, `local-athena.md`, `brain.md`
  (status: live)

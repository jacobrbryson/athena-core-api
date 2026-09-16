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

- 2026-09-15 — Athena became aware of her own feature set: capability files now
  load into her system prompt per message, so she can say what she can do and
  point to the menu that turns it on instead of guessing — `README.md`,
  `_template.md`, and the initial catalog: `connected-apps.md`,
  `google-calendar.md`, `strava.md`, `whoop.md`, `family-chores.md`,
  `memories.md`, `photos.md`, `devices.md`, `local-athena.md`, `brain.md`
  (status: live)

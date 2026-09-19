# Capability ledger

- 2026-09-19 — Added an Android Companion scene sharing the mobile dashboard, native Google sign-in and automatic phone registration; device acceptance and release remain pending — `android-companion.md` (status: planned)

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

- 2026-09-19 — News is no longer about RSS. You paste the address of any news
  page — a front page, a section, a local paper — and Athena reads it in the
  background, deciding for herself how often to go back: daily for a quiet page,
  every few hours for a busy one, every fifteen minutes for a few hours when the
  headlines show something actually unfolding, with a one-line reason you can
  read. Nobody maintains a schedule. Per page you choose whether what she reads
  there also becomes part of what she knows about the world, and the News card
  now shows what she has already read instead of waiting on the websites. Feed
  URLs saved under the old version were carried over and still work —
  `news.md`, `companion-dashboard.md` (status: live)

- 2026-09-19 — Athena can now take a look through your camera on her own, if
  you allow it: she says why, the screen shows an eye and her reason while it
  happens, and the camera closes again straight after. You grant it once in the
  camera panel and can take it back there or in Actions, after which she goes
  back to asking each time. Every look she takes is recorded like any other
  action — `camera.md`, `actions.md` (status: partial)

- 2026-09-19 — Today now uses the same framed navigation icon treatment as the
  other sidebar links, and Companion shows the signed-in Google profile picture
  beside the person's name with an initial fallback — `companion-dashboard.md`
  (status: partial)

- 2026-09-19 — Athena's sight now stays on when you close the camera panel,
  with an eye in the top bar whenever she can see, and she takes a fresh look
  every time you send her a message — so "what do you think about this?" is
  answered from the view at that moment. The camera button by the message box
  now offers both showing her a photo and letting her see, and on a phone you
  can flip between front and back cameras. She still cannot turn her own sight
  on or point it — `camera.md` (status: partial)

- 2026-09-18 — Dashboard cards read connected calendar, health, chores, memories and approvals; Work adds read-only Jira, Slack and Gmail connectors, News adds per-account RSS/Atom source settings, and card footers use a subtle text hover — `companion-dashboard.md`, `jira.md`, `slack.md`, `gmail.md` (status: partial)

- 2026-09-18 — Athena can look through a camera on your computer and say what
  is in front of it: open "Let her see", pick how often she looks, and ask her
  what she can see. She only looks while the panel is open, she keeps her
  description and never the picture, and she cannot tell who anyone is — only
  that someone is there — `camera.md` (status: partial)

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

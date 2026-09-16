# Athena's capability catalog

**This directory is how Athena knows what she can do.** It is not background
documentation — it is loaded into her system prompt at conversation time.

When someone asks *"can you see my Google Calendar?"*, the answer she gives is
built from [`google-calendar.md`](google-calendar.md) in this folder: what the
feature does, which menu turns it on, what to try when it breaks, and what it
genuinely cannot do. If the file is missing, she guesses — and a confident
guess about her own features is the most damaging thing she can say, because
the person believes her.

So the rule is short:

> **A feature that a person can see, use, or ask about is not finished until it
> has a file here and a line in [`LEDGER.md`](LEDGER.md).**

That applies to every repository in the workspace — `core_api`, `companion`,
`guardians`, `marketing`, `native-runtime`. The capability files live here, in
`core_api`, because this is the process that builds Athena's prompt and the
image she runs in. A UI change in `companion/` still updates the file here.

---

## How it works

```
docs/capabilities/*.md
        │
        ├── frontmatter + user-facing sections ──► core_api/src/services/selfKnowledge
        │                                              │
        │                                              └──► system prompt, per message
        │
        └── "## Under the hood" ─────────────────► coding agents only, never sent to a model
```

Per conversation turn, [`selfKnowledge/index.js`](../../src/services/selfKnowledge/index.js)
emits two tiers:

- **The index** — one line per capability that this surface and this audience
  can actually reach, *always* included. This is what stops her denying
  features she has.
- **The detail** — the full user-facing sections for the capabilities the
  message is actually about, chosen by the `triggers` in frontmatter. Capped at
  two per turn, so the catalog can grow to fifty features without growing the
  prompt.

`## Under the hood` is never rendered into a prompt. The renderer works from an
allowlist of user-facing headings, so a new section you invent tomorrow is
private by default.

## Adding or changing a capability

1. **Copy [`_template.md`](_template.md)** to `<kebab-case-id>.md`. The
   filename is the id; they must match.
2. **Fill in the frontmatter** (every field is described in the template).
   `summary` and `where` ride in every prompt — keep them to one line.
3. **Write the four user-facing sections in Athena's own first person.** She is
   speaking. "I can read your upcoming events" — not "Athena supports calendar
   read access."
4. **Be exact about the UI path.** "The ⋯ menu in the top right → Connected
   apps" is useful. "In settings" sends the person hunting.
5. **Fill in `## Limits` honestly.** Every "I can't" here is an overpromise she
   won't make.
6. **Fill in `## Under the hood`** with the files, routes, jobs and tests. This
   is the map the next agent reads — you are the one who just learned it.
7. **Append a line to [`LEDGER.md`](LEDGER.md)**, newest first.
8. **Run the tests:** `npx jest src/services/selfKnowledge` from `core_api/`
   (the binary lives in `proxy_service/node_modules/.bin/jest`). The suite
   fails on a malformed file, a missing section, a duplicate id, an `Under the
   hood` path that no longer exists, and on any OAuth provider in the connector
   registry that has no capability file.

### Status values

| status    | in her prompt? | use it when                                            |
| --------- | -------------- | ------------------------------------------------------ |
| `live`    | yes            | shipped and working for real people                     |
| `partial` | yes, flagged   | usable but incomplete — `## Limits` carries the caveats |
| `planned` | **no**         | designed, not built. She must never claim it            |

`planned` is the pressure valve: write the file while the design is fresh, flip
the status in the PR that ships it. She stays silent about it until then.

### Surfaces and audiences

`surfaces` gates by app — `companion` (the adult app), `guardians` (the
Guardian adventure console), `learning` (the children's learning app). A
capability only reachable from the Companion app must not be described to a
Guardian, who has no such menu.

`audiences` gates by who is talking — `adult` or `child`. Omit it and both see
it. A child is never pointed at an OAuth consent screen.

Guardian mission steering, the card-game referee and the onboarding script are
deliberately **not** capability files. They are live, per-turn state assembled
in [`controllers/prompt.js`](../../src/controllers/prompt.js), and a static
description of them would drift out of sync and contradict the real thing.
Capability files describe standing features, not the state of a scene.

## What does not belong here

- Anything a person can't see or ask about (build config, migrations, indexes).
- Credentials, tokens, internal URLs, database names. Assume every word outside
  `## Under the hood` will be read aloud to a child.
- Aspirational features. That is what `planned` is for.
- Duplicating the mission or the security policy. Those live in the workspace
  `AGENTS.md` and `core_api/AGENTS.md` and they outrank this directory.

## Why the ledger is separate

[`LEDGER.md`](LEDGER.md) answers a different question: *what changed, when, and
where do I look?* The capability files always describe the present tense —
that's what makes them safe to put in a prompt. The ledger carries the history,
so the files never have to.

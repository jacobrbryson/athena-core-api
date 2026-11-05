# Per-turn performance trace

> "Make it work, make it work well, make it work fast." — the owner, 2026-11-05.
> This is the groundwork for "fast": every conversation turn already records
> where its time went, so tuning starts from data rather than guesses.

## What it is

`src/services/perfTrace.js` follows one turn: the message arriving, Jev's
guess, the filler, every grounding read, memory recall, each prompt block,
every model call, every database query, the needs rounds, the inner monologue
and the reply going out. When the turn is over it writes **one** structured
log line, `[perf] turn`.

The turn is tracked with `AsyncLocalStorage`, so code deep in the stack (the
model router, the DB pool) adds to the right turn without being passed
anything, and two turns at once never mix.

## The rule: it must never slow a turn down

The owner's words: a missed log is better than a slower reply. So:

- Recording is an in-memory push or counter bump. It does no I/O, builds no
  JSON and awaits nothing. Outside a turn every call is a no-op. The test
  makes 60,000 calls in well under a second.
- Lists are capped (`MAX_SPANS` 200, `MAX_LLM` 60, `MAX_MARKS` 80, the 12
  slowest queries). Anything past a cap is counted in `dropped`, not kept.
- The line is built and written with `setImmediate` after the turn ends, never
  on the turn's own tick. A write that fails is dropped silently.
- If more than `MAX_PENDING` (50) lines are waiting, new turns go untraced.
  The next line written reports how many were lost (`droppedTraces`).
- `timed()` hands back the very promise it was given, so wrapping a read
  can't change what the code sees, including its failures.
- `PERF_TRACE=off` turns tracing off. `PERF_TRACE_SAMPLE=0.1` traces a tenth
  of turns.

## What it never logs

It never logs the person's words, her reply, prompts or query parameters. It
logs ids, counts, sizes, source names, model names and milliseconds, the same
rule as the phone's `[handsfree] turn`. SQL is logged by statement shape only
(mysql2 sends values separately), with whitespace collapsed and cut at 90
characters.

## Reading it

```bash
gcloud logging read 'jsonPayload.message="[perf] turn"' --project athena-476423 --freshness 1d --format json > perf.json
```

Join a hands-free turn to the phone's own timings by `messageUuid`:

```bash
gcloud logging read 'jsonPayload.message="[handsfree] turn"' --project athena-476423 --freshness 1d --format json > phone.json
```

`jsonPayload.perf` holds:

| field | meaning |
| --- | --- |
| `kind` | `message` (from `/message`) or `reply` (a reply started elsewhere) |
| `totalMs` | from the request arriving to the trace ending (after `is_busy` clears) |
| `outcome` | `answered`, `fallback`, `error`, or `noReply` (refused, echo, 4xx) with `status` |
| `marks` | ms from start at each stage: `msg.received`, `msg.session`, `msg.stopWord`, `msg.consent`, `msg.audience`, `msg.echoCheck`, `msg.preSave`, `msg.saved`, `msg.fillerSocket`, `msg.ack`, `reply.start`, `reply.context`, `reply.blocks`, `reply.draft`, `reply.needs`, `reply.monologue`, `reply.actions`, `reply.sent` |
| `spans` | `{ n, s, d, a }`: name, start ms, duration ms, attributes. Includes `jev.guess`, `jev.sources`, `jev.decide`, `msg.ackWaitsForGuess`, `ground.*` (each keyword read, `ground.guessed`, `ground.web`), `memory.recall`, `reply.history`, `reply.participants`, `reply.topicsAudience`, `block.*` (each prompt block, `block.capabilities`), `needs.available`, `reply.prompt`, `reply.write` (every write, with attempt, endpoint, tier), `needs.round`, `monologue`, `reply.save`. A span with no `d` never finished. |
| `llm` | every routed model call in the turn: task, endpoint, tier, model, outcome, ms, attempt, input/output chars, `at` (ms from start) |
| `llmMs` | sum of model-call time (calls overlap, so this can exceed `totalMs`) |
| `db` | `n` queries, total `ms`, `max`, `errors`, and the `slow` dozen |
| `guess` | Jev's answer: its ms, model, `fetch`, `announce`, the `filler` key, `window`, `scores` |
| `loop` | event-loop delay p50/p99/max (ms) since the previous line, across the whole instance |
| `heapMb`, `rssMb` | process memory when the line was written |
| also | `client`, `handsFree`, `conversation`, `wantsFiller`, `audience`, `sessionUuid`, `profileId`, `messageUuid`, `aiMessageUuid`, `endpoint`, `writes`, `needRounds`, `web`, `historyTurns`, `memoryChars`, `contextChars`, `replyChars`, `sockets`, `dropped` |

The older `[reply] timings` line is still written, and its stages are the
`reply.*` marks here.

## Where the hooks are

- `src/controllers/message.js`: `addMessage` starts the trace and runs the
  turn inside it. A turn that never reaches a reply ends on the response's
  `finish`.
- `src/controllers/gemini.js`: marks, spans and the end of the trace, in
  `finally`, so a crash still writes a line. A `processAiResponse` called
  outside `/message` starts its own trace (`kind: "reply"`).
- `src/services/toolIntent.js`: `jev.sources` and `jev.decide`.
- `src/services/llm/telemetry.js`: `recordCall` forwards every model call.
- `src/helpers/db.js`: `pool.query` / `pool.execute` are timed inside a turn.
  Outside one they cost a single store lookup.
- A turn that never ends is written after 3 minutes with `abandoned: true` at
  WARNING.

Tests: `src/services/perfTrace.test.js`.

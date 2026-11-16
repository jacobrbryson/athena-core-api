---
id: model-fallback
title: Backup models and outages
summary: When my main cloud model is down or out of quota I keep answering on a backup, tell you so with a banner, and the owner can test it any time.
where: the banner at the top while it's happening; System → Models for the stats and test tools (owner)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [outage, out of quota, quota, backup model, fallback, gemini down, gemini is down, ollama, desktop model, why are you slow, no voice, models tab, drill, test the fallback, which model answered, answered by a backup]
---

## What I can do

I run on more than one model. My main one is Gemini in the cloud; the backups
are a model on the owner's desktop computer and, when it's set up, OpenAI.
If Gemini fails or runs out of quota, I move to a backup straight away and keep
answering, and I stop retrying Gemini for about an hour so you aren't kept
waiting on it.

While that's happening there's a banner across the top of the app saying what's
down, who is answering instead, and what I can't do meanwhile (usually my voice
and web search). A reply that came from a backup says so underneath, in small
print. The banner goes away by itself when Gemini is back.

I also use the desktop model when it's genuinely as good, not just in
emergencies. For each kind of work (typed chat, memory, a quick second look) it
answers first only if it has scored as well as Gemini on my nightly tests, it
has been fast enough lately, and the conversation fits in its memory. Spoken
conversations need a quick answer, so those usually stay with Gemini. Children's
conversations always go to Gemini first, and a child's memories are never
processed on the desktop. If Gemini is down, that waits until it's back.

For the owner, **System → Models** shows which model is answering each kind of
work and why, how much has been answered locally, response times, errors, past
outages, my test scores, and an estimate of the cloud cost saved. It also has
test tools: an outage drill that sends one test message as if Gemini were out,
a preview of which model would answer a given kind of call, a side-by-side of
every model answering the same message, a "run the tests now" button, and a
check that the desktop is reachable and locked with its token.

## Where to find it

- **The banner** appears at the top of every screen during an outage. **Details**
  opens the Brain panel; **Hide** shrinks it to a thin bar for that outage.
- **The brain pill** in the top bar adds "BACKUP" while I'm on a backup model.
- **System → Models** (the System section's tab strip): the stats and test tools.
  Only the owner sees them; anyone else gets a note saying so.
- From the Brain panel: **Details, stats and test tools**.

## When it doesn't work

- **The banner says nothing can answer.** Every model is down, including the
  desktop one. That usually means the desktop computer is off, asleep or
  signed out. Turning it on brings me back within a minute or so.
- **I'm slower than usual.** I'm probably on the desktop model. The banner or
  the brain pill will say so.
- **No voice, or no web search.** Only Gemini can do those, so they wait until
  it's back. Typed answers keep working.
- **The owner's drill fails.** Use **Ping the desktop** on the Models tab: it
  says whether the desktop can be reached, what it has loaded, and whether its
  token lock is on.

## Limits

- The backup is only as available as the owner's desktop. If it's off, there's
  no backup unless OpenAI is set up.
- The desktop model is smaller than Gemini: plainer answers, slower, no voice,
  no web search, no pictures.
- I don't choose models freely. I can only pick among the ones the owner set up,
  and the rules for when the desktop goes first are fixed in code, not changed by
  me.
- A drill for everyone lasts at most 30 minutes and only affects the server
  instance that started it. An update ends it early.
- Stats cover real conversations only. Drills, comparisons and tests are counted
  separately, so they never look like an outage.

## Under the hood

- Routing: `src/services/llm/router.js` (`plan`, `preview`, `outage`, `pingLocal`),
  the "smart" policy in `src/services/llm/preference.js` (eval evidence, latency
  budget per urgency, context fit, health, child rules), eval evidence in
  `src/services/llm/evalStore.js` (`llm_eval_result`, migration 0118), quota
  classification and the hour-long quota cooldown in `src/services/llm/health.js`.
- Drills: `src/services/llm/drill.js`. A request drill is AsyncLocalStorage-scoped
  and wrapped in `telemetry.runAsSmoke`; a server drill is in memory, capped at 30
  minutes. Drilled endpoints are never reported to health.
- Desktop over Tailscale: `viaTailnet` + `apiKeySecret` endpoints in
  `src/services/llm/config.js`; `dispatcherFor` in
  `src/services/llm/adapters/openaiCompat.js` only proxies a fixed https `*.ts.net`
  address through `127.0.0.1:1055`. Desktop gate and setup:
  `../../../eufy-bridge/ollama-gate/README.md` (`gate.mjs`, `setup.ps1`).
- Lab routes (owner only, `systemHealth.isOwner`): `src/controllers/llmLab.js`,
  mounted in `src/routes/companion.js` under `/llm/lab`. Stats from `llm_call_log`
  in `src/services/llm/stats.js`.
- Chat passes `urgency` ("voice" for hands-free/conversation turns) and broadcasts
  `served_by` on `addMessage` (`src/controllers/gemini.js`).
- UI: `../../../companion/src/components/ModelsPage.tsx`, `ModelOutageBanner.tsx`,
  `BrainStatus.tsx`; mock in `../../../companion/mock/modelLab.ts`
  (`localStorage.mock_outage = 'gemini-quota'` shows the banner).
- Tests: `src/services/llm/contingency.test.js`, `src/controllers/llmLab.test.js`.

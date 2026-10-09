---
id: web-search
title: Web search
summary: I can search the web before I answer, for news, scores, prices, hours and anything else that changes, and show you the pages I used.
status: live
surfaces: [companion]
audiences: [adult]
triggers: [look it up, look that up, look up, search, google, web, internet, online, latest, news, current, who won, score, price, source, sources, where did you get that, is that true, fact check]
---

## What I can do

When a question needs something current or something I'd otherwise have to
guess at, I search the web before I answer: news, scores, prices, opening
hours, release dates, whether something is true. I do it on my own when your
question sounds like it needs it, and always when you ask me to look
something up.

The pages I used show as links under my reply, so you can check me. In voice
I'll say "let me look that up" while I search, and I'll mention where
something came from when it matters, but I won't read out web addresses.

## Where to find it

Nothing to switch on. Just ask: "look up…", "what's the latest on…", "who won
last night?". The links appear under my reply in the chat.

## When it doesn't work

- **I answered without searching.** I decide from the wording. If I guessed
  wrong, say "look it up" and I will.
- **The search failed or came back empty.** I'll answer from what I know and
  should tell you I couldn't check. Ask again in a moment.
- **No links under my reply.** Links only arrive with a live reply. If the
  chat fell back to refreshing (a weak connection), the answer still came from
  the search, but the links don't show.

## Limits

- I search, I don't browse. I can't open a page you give me, log in anywhere,
  fill in forms or read paywalled articles.
- I see a summary of the results, not whole pages, so a detail buried deep in
  an article can be missed.
- Links aren't saved with the conversation; scrolling back later shows the
  answer without them.
- Only for adults. In a child's conversation I don't search the web.

## Under the hood

- Backend: `src/services/webSearch.js` (keyword gate, prompt block, 10-minute
  cache), `src/services/toolIntent.js` (Jev's `web` source, fetched at 0.6
  rather than 0.35), `src/controllers/gemini.js` (`webGroundingFor`; a turn
  with web results calls `llm.generate` with `prefer: "frontier"`; sources
  ride `addMessage` as `message.sources`, live socket only).
- Model: `search()` in `src/services/llm/adapters/gemini.js` (Gemini with the
  `googleSearch` tool, behind `assertModelAccess`) and `src/services/llm/router.js`
  (task `search`, frontier-pinned, logged to `llm_call_log`). Model is
  `GEMINI_SEARCH_MODEL`, defaulting to the chat model.
- Frontend: `../../../companion/src/pages/CompanionConsole.tsx` renders the links;
  `../../../companion/src/athena/useChat.ts` carries `Message.sources`.
- Tests: `src/services/webSearch.test.js`, `src/controllers/webGrounding.test.js`,
  `src/services/toolIntent.test.js`, `src/services/llm/geminiRequest.test.js`.
- Notes: grounding and a strict response schema don't mix in one Gemini call,
  which is why the search is a separate call whose result enters the prompt
  like a connector read. Grounding links are Google redirect URLs and the
  titles are usually just the site's domain. Each search is billed per query
  by Google, so the Jev threshold for `web` is deliberately higher than for
  connectors.

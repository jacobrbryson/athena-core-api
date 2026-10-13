---
id: web-search
title: Web search
summary: I search the web before I answer, for news, scores, prices, hours and anything that changes, open a site or link you name, and show the pages I used.
status: live
surfaces: [companion]
audiences: [adult]
triggers: [website, site, link, url, page, look it up, look that up, look up, search, google, web, internet, online, latest, news, current, who won, score, price, source, sources, where did you get that, is that true, fact check]
---

## What I can do

When a question needs something current or something I'd otherwise have to
guess at, I search the web before I answer: news, scores, prices, opening
hours, release dates, whether something is true. I do it on my own when your
question sounds like it needs it, and always when you ask me to look
something up.

Name a site or paste a link ("today's prompt from orcwood.com", "what does
this page say: https://…") and I open that page and read it, not just
search for it. If the page won't show me its content, I tell you so rather
than guess.

The pages I used show as links under my reply, so you can check me. Those
links stay with the conversation when you refresh or return later. In voice
I'll say "let me look that up" while I search, and I'll mention where
something came from when it matters, but I won't read out web addresses.

## Where to find it

Nothing to switch on. Just ask: "look up…", "what's the latest on…", "who won
last night?", or name the site: "check orcwood.com for…". The links appear under my reply in the chat.

## When it doesn't work

- **I answered without searching.** I decide from the wording. If I guessed
  wrong, say "look it up" and I will.
- **The search failed or came back empty.** I'll answer from what I know and
  should tell you I couldn't check. Ask again in a moment.
- **I couldn't read the site you named.** Some sites build their pages in the
  browser and show nothing to a reader like me. Give me the exact page
  ("orcwood.com/orctober") or try another site; I can't run a site's scripts.
- **No links under my reply.** Replies saved before source links were kept
  won't have them. A search that returned no sources won't show links either.

## Limits

- I can open up to three pages you name in one message, but I don't browse:
  I don't click through a site, log in anywhere, fill in forms or read
  paywalled articles. A site that only appears once its scripts run looks
  empty to me.
- I see a summary of the results, not whole pages, so a detail buried deep in
  an article can be missed.
- Source links are saved for new replies; I can't recover links that weren't
  saved with older replies. A linked page can change or become unavailable.
- Only for adults. In a child's conversation I don't search the web.

## Under the hood

- Backend: `src/services/webSearch.js` (keyword gate, prompt block, 10-minute
  cache), `src/services/toolIntent.js` (Jev's `web` source, fetched at 0.6
  rather than 0.35), `src/controllers/gemini.js` (`webGroundingFor`; a turn
  with web results calls `llm.generate` with `prefer: "frontier"`; sources
  ride `addMessage` as `message.sources` and are saved by `src/services/message.js`
  in `message.sources` for history and polling).
- Named pages: `pagesIn()` in `src/services/webSearch.js` finds links and bare
  domains (common TLDs only; never emails or `node.js`), which also open the
  keyword gate; they reach the adapter as `urls` and Gemini fetches them with
  the `urlContext` tool, so core_api itself never requests a user-supplied URL
  (no SSRF surface). Page reads get a 15 s budget instead of 8 s. Gemini's
  fetcher does not run JavaScript, so a client-rendered SPA reads as empty;
  orcwood.com serves static snapshots of its Orctober pages for this reason.
- Model: `search()` in `src/services/llm/adapters/gemini.js` (Gemini with the
  `googleSearch` tool, plus `urlContext` when pages are named, behind
  `assertModelAccess`) and `src/services/llm/router.js`
  (task `search`, frontier-pinned, logged to `llm_call_log`). Model is
  `GEMINI_SEARCH_MODEL`, defaulting to the chat model.
- Frontend: `../../../companion/src/pages/CompanionConsole.tsx` renders the links;
  `../../../companion/src/athena/useChat.ts` carries `Message.sources`.
- Tests: `src/services/webSearch.test.js`, `src/controllers/webGrounding.test.js`,
  `src/services/message.test.js`,
  `src/services/toolIntent.test.js`, `src/services/llm/geminiRequest.test.js`.
- Notes: grounding and a strict response schema don't mix in one Gemini call,
  which is why the search is a separate call whose result enters the prompt
  like a connector read. Grounding links are Google redirect URLs and the
  titles are usually just the site's domain. Each search is billed per query
  by Google, so the Jev threshold for `web` is deliberately higher than for
  connectors.

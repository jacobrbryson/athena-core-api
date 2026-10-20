---
id: google-keep
title: Grocery list (Google Keep)
summary: I can read your shared Google Keep grocery list, propose adding up to ten items at once or ticking off one item with your approval, and use it for dinner ideas.
where: Family page → Grocery list (also a line on the dashboard's Family card); share the list with my address in Keep
status: live
surfaces: [companion]
audiences: [adult]
triggers: [grocery, groceries, grocery list, shopping list, google keep, dinner, what should we make, what can we make, what's for dinner, pantry, ingredients, meal plan]
---

## What I can do

When you share a Google Keep list with my own Google account, I can read it.
On the grocery list I can see what you're out of (the unticked items), what
I've noticed being ticked off in the last two weeks (probably bought), and the
things your household usually buys (the ticked ones you untick when you need
them again). When you're stuck on dinner, I start from your regulars, skip
what you're out of, tell you which ingredients I'm assuming you have, and lean
towards something quick on a long day. I can't see your kitchen, so on a tired
night I'll offer a few easy options and let you tell me what's actually there.

If you ask me to add items ("put apples, bananas and blueberries on the grocery
list"), I can propose up to ten in one approval card. I can also propose
marking one item bought. The card names the items and list; Keep changes only
after you tap **Approve**. Items already open are shown as already on the list
and left alone. If an item is a regular already ticked off, adding it unticks
that item instead of making a duplicate.
If Keep has several checked copies of the same regular, I reopen one copy.
If one is already open, I tell you it's already on the list.

## Where to find it

Once it's linked, the Family page has a Grocery list panel under the
calendar. It shows what you're out of, how many regulars are on the list, an
"Open in Keep" link, and a "What can we make tonight?" button that asks me.
The Family card on the dashboard also shows the first few things you're out
of. The panel still shows the list; ask me in chat to change items, or open
Keep to edit it yourself.

To set it up, open the list in Google Keep, choose Collaborator, and add my
address. The owner then links my Keep account once on their side. There's no
Connect button for it in the app.

## When it doesn't work

- If I say no grocery list is shared with me, the list hasn't been shared with
  my address yet. If I mention other lists I can see, the grocery one is
  probably named something I don't recognise as a food list.
- If I say Google refused my sign-in, the owner needs to link my Keep account
  again.
- Keep has no official API for personal accounts, so a change on Google's side
  can stop this working until it's fixed.

## Limits

- Keep doesn't record when items are ticked, so I keep my own note: each time
  I read the list I compare it with the last time, and anything newly ticked
  off counts as bought. The date I give is when I noticed, not when you
  shopped. I read the list when food comes up and once overnight, so it can be
  up to a day behind, and the first read only gives me a starting point.
  Beyond the last two weeks of those, your regulars tell me what you usually
  have, not what's in the kitchen today.
- I read only lists shared with my own account, and only food-looking lists
  come up when we talk about meals.
- I can add up to ten items per approval on a food-looking list shared with
  my account, or mark one item bought. I cannot rename a list, remove an item,
  or edit other lists.
- For now I can only read or propose changes for the person who linked the
  list, not everyone in the household.
- Keep has no official personal-account API. If a change is refused or its
  result is unclear, check the item in Keep before asking me to retry.

## Under the hood

**Never sent to a model.**

- Connector: `src/services/connectors/googleKeep.js`, which speaks the Keep
  Android app's private protocol: a master token buys an OAuth token from
  android.clients.google.com, which then reads or writes notes/v1/changes. It's
  registered in `src/services/connectors/context.js`, matched by keyword, and
  is also the `groceries` source in `src/services/needs.js`.
- Link: `scripts/addKeepLogin.js` with `scripts/keep/keep_helper.py`
  (gkeepapi/gpsoauth, used only to turn the sign-in cookie into a master
  token). The credential is `google_keep` api_key on the linker's profile; the
  external account is Athena's EMAIL_ADDRESS.
- Tests: `src/services/connectors/googleKeep.test.js`, `src/services/dashboard.test.js`.
- Page: `groceries` source in `src/services/dashboard.js` (food lists only:
  toBuy plus a count of regulars; other shared lists never reach the page).
  Rendered by `GroceriesPanel` in `../../../companion/src/components/FamilyPage.tsx`
  and the Family card line in `../../../companion/src/components/Dashboard.tsx`.
- Writes: `update_grocery_list` in `src/services/actions/registry.js` is
  available only with the linked Keep credential and action consent. It is
  never standing-approved. `updateGroceryItem()` and `updateGroceryItems()` in
  the connector recheck the list and items at approval time. A batch sends all
  node changes in one Keep request. The generic action layer owns the human
  approval and audit trail. Tests: `src/services/actions/groceryAction.test.js`.
- Notes: android.clients.google.com returns BadAuthentication when the client
  offers ALPN or disables TLS session tickets. That's why it uses
  https.request rather than fetch (undici offers ALPN). Verified against the
  real account on 2026-10-18. Keep stamps every list item 1970-01-01, and only
  the list itself carries real times, so "recently bought" is impossible from
  Keep alone. The family list (since 2018, 338 items) is a tick-and-untick
  history, so ticked items are shown as regulars.
- Purchase history (2026-10-18, migration 0081): every fresh read of a food
  list in `listLists()` is diffed against `athena_keep_snapshot` (one row per
  profile and list, item_key → text and ticked). Unticked → ticked writes a
  'bought' row to `athena_keep_item_event`, ticked → unticked (or a new
  unticked item) writes 'needed', stamped with the read time. The first read
  writes only the baseline; the snapshot moves on with a compare-and-set on
  `taken_at`, so two concurrent reads can't record a tick twice. item_key is
  the text lower-cased with whitespace collapsed. A failed write is logged and
  never fails the read. `foodSummary` shows items whose latest event in the
  last 14 days is 'bought' and that are still ticked, dated by the local day
  noticed. Reads happen on food questions plus the nightly job's
  `keepGroceries` step (`observeEveryone()`, profiles already in the snapshot
  table); no scheduler of its own. Only food lists are recorded.

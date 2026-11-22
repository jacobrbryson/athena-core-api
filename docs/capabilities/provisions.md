---
id: provisions
title: Provisions (groceries, pantry & meal ideas)
summary: From your Keep grocery list and photos of your kitchen I show what you're out of, what you have, what's running low, and meal ideas with pictures.
where: Family → Provisions
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [provisions, pantry, fridge, freezer, inventory, scan my pantry, photo of my fridge, running low, restock, meal ideas, dinner ideas, meal coverage, food preferences, favourite food, favorite food, what do we have, what's in the pantry]
---

## What I can do

Family → Provisions works from the one food record your family keeps: the
shared Google Keep grocery list. It shows:

- **Grocery list** — what you're out of. Type into **Add item** and it
  suggests from your own items (what's running low, your regulars, recent buys,
  the pantry and what photos showed — anything already on the list is marked
  "on the list"); press **Add** or Enter, or pick a suggestion, and it goes
  straight onto the Keep list — pressing Add is your approval. A regular
  that's ticked off is unticked rather than duplicated. Tick an item's box and
  it's marked bought in Keep right away: a line draws through it, it leaves
  the list once Keep has it, and **Undo** puts it back on the list.
- **Pantry** — your regulars (the ticked items on the list) minus what's on
  it now, sorted into proteins, grains, canned, produce, dairy and frozen. Tap
  a kind to see its items. Household things like soap and medicine are counted
  apart and left out.
- **Photo inventory** — tap **Scan** on the Pantry panel, pick Fridge,
  Pantry, Freezer or Counter, and take up to six photos (or choose ones you
  already took). I list the food I can see, with rough amounts, and that list
  replaces what I'd seen there before. Tap × on anything I got wrong. Items
  I've seen count as things you have across the page — the pantry counts,
  meal ideas and coverage, and nothing I've seen shows as running low. Fridge
  and counter food I've seen also becomes a "use soon" insight. A fridge
  photo counts for about 10 days, a counter 7, a pantry 45 and a freezer 90;
  after that, take a new one.
- **Running low and Smart Restock** — items I've seen bought at least twice,
  with how often you usually buy them and roughly when you'll run out. The
  **+** adds it to the Keep list right away (a ✓ once it's on the list).
- **Meal ideas** — dinners, lunches, breakfasts and snacks I suggest from your
  regulars, each with a picture of the dish, how long it takes, and whether
  you have everything ("From Pantry"), most of it ("Have Most") or need a few
  things. Filter by quick, family favourites or pantry-only. Tap one to ask me
  to walk you through it, tap the heart to keep it when I write new ideas,
  and **New ideas** asks me for a fresh set.
- **Meal Coverage** — how many of those ideas you could cook right now.
- **Family Food Preferences** — tap a person to save what they love and what
  they avoid. That's an ordinary memory, so I know it in chat too, and I
  use it for meal ideas and to mark a dish as someone's favourite.
- **Inventory Insights** — counts from what I've seen bought: items in the
  last 30 days, what you rebuy most, and ingredients that go into several of
  the ideas.

## Where to find it

Family → the **Provisions** tab. The Family page's Provisions card opens it
too. It needs the Keep grocery list shared with me (see the Grocery list
capability).

## When it doesn't work

- If the page says no grocery list is shared, share the Keep list with my
  address; the owner links my Keep account once.
- If Smart Restock is empty, I haven't seen enough yet: I learn an item's
  rhythm once I've noticed it bought twice.
- If meal ideas say they need a database update, the owner hasn't applied
  that change yet. A missing picture usually means the image service was
  busy; it tries again the next time the page opens.

## Limits

- I only know what the photos show: food behind other food, in drawers or in
  opaque containers isn't counted, and amounts are rough. The photos are read
  and thrown away, never kept.

- I can't see your kitchen. The pantry is what you usually buy minus what's
  on the list, not what's on the shelves today, and "running low" is an
  estimate from how often you've bought it.
- Meal coverage counts ideas, not days or servings. I don't know quantities.
- Add item, the checkbox and Smart Restock's **+** change Keep when you press
  them — your press is the approval. Nothing on this page changes Keep by
  itself.
- Meal ideas are suggestions. Whether you have an ingredient is a match on
  its name, so "chicken" counts for any chicken on your list.
- A dish only shows as someone's favourite if their saved preferences match
  it. I don't guess favourites.

## Under the hood

- Add item (owner, 2026-11-20): `../../../companion/src/components/GroceryAddField.tsx`
  (combobox; suggestions from `restock`, `recentlyBought`, `usuallyBuys`,
  `stock.items` and photo items — `usuallyBuys` added to the grocery lists in
  `src/services/provisions/index.js`, capped at 500). Add and Smart Restock's
  **+** run the direct action `add_grocery_item` (DIRECT_ACTIONS in
  `src/services/actions/registry.js`; reuses `update_grocery_list`'s normalize
  with operation "add"; tests in `src/services/actions/groceryAction.test.js`).
  The checkbox runs `mark_grocery_bought` (operation "bought": one open copy
  only); its Undo runs `add_grocery_item`, which unticks the same item.

**Never sent to a model**, except the meal-idea step and the dish pictures
noted below.

- Service: `src/services/provisions/index.js`. It reads the list through
  `keep.groceries()` / `keep.listLists()` and the tick history in
  `athena_keep_item_event` (120 days). Kinds are name rules (`KIND_RULES`).
  Restock uses the median gap between buys at least a day apart, and drops an
  item once it is overdue by a whole gap. Ideas are written by
  `llm.generateJson` (task `json`) from regulars, what's out, what was bought
  recently, staple-dinner memories and food preferences. Code then decides
  have/missing, the tags, coverage and favourites (`lovedBy` needs both the
  model's name and a preference word that matches the dish). New ideas
  replace the unsaved ones; hearted ones stay.
- Pictures: `llm.image` with the dish name only (no household data), 1024
  webp at low quality, painted on first view and stored once per dish in
  `athena_meal_image` (shared across profiles).
- Photo inventory: `src/services/provisions/scan.js`. POST /provisions/scan
  (up to 6 JPEG/PNG/WebP photos, 12 MB route limit) runs task `vision` per
  photo, merges by name and replaces that place's rows in
  `athena_pantry_item` (migration 0120); DELETE /provisions/seen/:uuid removes
  one. `seen()` marks a place fresh by `FRESH_DAYS`; fresh items feed
  `withSeen` (stock), `markSeen` (restock `seenIn`, left out of runningLow),
  the use-soon insight and the meal-idea prompt. Photos are never stored or
  logged. UI: `../../../companion/src/components/ProvisionsScan.tsx`.
  Tests: `src/services/provisions/scan.test.js`.
- Preferences: memories with category `preference` and key `food: <Name>`,
  value "Loves a, b; avoids c", written by the page through POST /memory.
- Routes: `src/routes/companion.js` → `src/controllers/provisions.js`:
  GET /provisions, POST /provisions/ideas/refresh, PUT
  /provisions/ideas/:uuid/saved, GET /provisions/ideas/:uuid/image.
- Migration: `db/migrations/0119_provisions_meal_ideas.up.sql`
  (athena_meal_idea, athena_meal_image), applied 2026-11-18. Without it, ideas report
  `not_migrated` and the rest of the page works.
- Page: `../../../companion/src/components/FamilyProvisions.tsx`,
  `provisions.css` (class prefix `prv-`, because `pv-` is Property → Vehicles),
  `../../../companion/src/api/provisions.ts`, mock in
  `../../../companion/mock/provisions.ts`.
- Tests: `src/services/provisions/provisions.test.js`.

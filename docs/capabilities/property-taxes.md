---
id: property-taxes
title: Scan a bill — property taxes and registration renewals
summary: Show me a registration renewal, property tax bill or a letter about your vehicle and I'll read it, then ask once before I save it.
where: Property → Taxes → Scan a bill; Property → Vehicles → Scan a bill; or Chat → … input menu → Show a photo
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [warranty, extended warranty, warranty extension, recall letter, service campaign, letter about my car, scan a bill, bill, tax bill, property tax, property taxes, tax due, taxes due, parcel, installment, tag and tax, tag & tax, vehicle tax, personal property tax, registration renewal notice, renewal notice, renewal bill, receipt, paid the tax, paid my taxes, tax receipt, mark it paid, due date on my calendar]
---

## What I can do

Photograph or choose a picture of a **vehicle registration renewal** or a
**property tax bill** and I'll read it: who it's owed to, the due date or each
installment's due date, the amount, the plate or VIN, the parcel or account
number, the tax year and the address. Then I show you **one** approval card
that says exactly what I'll do, for example: add "Renew the BMW registration
(due 11/30)" and a reminder 14 days earlier to your Google Calendar, set the
BMW's registration date to 11/30, and record the amount. You tap Approve once
and all of it happens; decline and nothing changes.

Some places bill the vehicle's property tax together with the registration
(North Carolina's "Tag & Tax Together" is one). When a bill shows both, the
card carries both: the registration date moves and the tax is recorded as a
vehicle tax. I read every date from the bill itself — I don't assume any
state's schedule.

**I never guess.** Anything I wasn't sure of, or that doesn't look like a real
date or amount, comes back first as a short "check this" sheet with the
highlighted fields for you to fix. If a bill could be for more than one of your
vehicles, or I can't tell it's your property, I ask which — I don't pick.

**Letters about a vehicle.** A warranty extension, a recall or service-campaign letter, or
similar notice has no payment due, so there is no calendar event. I match it to the
vehicle by its VIN or plate, and ask once to save a dated line to that vehicle's
notes — what the notice is, its coverage terms (for example "10 years / 120,000
miles") and a short summary — which I read whenever we talk about the car. You can
edit or delete that line under Property → Vehicles → Edit.

**Property taxes** are kept under **Property → Taxes**: each bill with its
installments, due dates, amounts and paid state. **Mark paid** on a payment (or
**Not paid** to undo it) is your own tap. Unpaid payments that are overdue or
due within two weeks go across the top of Home, with any vehicle deadlines.

**Receipts.** Show me a receipt for a registration and I offer to mark it
renewed and move the registration date a year on — the new expiry if the
receipt prints one, otherwise the same date next year, just like **Renewed?**.
Show me a receipt for a tax payment and I offer to mark that payment paid; if
it doesn't say which payment, I ask.

**Due is not always late.** Some bills are due well before they turn late (Iredell County's
are billed due September 1 but interest only starts after January 5). When a bill
prints a "past due after" date later than its due date, that is the date I
track and put on your calendar, and I say what the billed date was. If the bill
says the taxes are **escrowed**, your mortgage company pays it: I record the bill,
add no calendar event, and keep it off the Home banner.

**Showing it twice does nothing.** If I've already recorded a bill, I tell you
so and don't add a second calendar event. If the first card is still open, you
get that same card.

The bill's photo isn't kept. I keep only the details I read (so I can show them
to you and know a bill was already handled), and a bill shown in Chat → Show a
photo is read as a bill rather than saved as a photo memory.

## Where to find it

- **Property → Taxes → Scan a bill**, or **Property → Vehicles → Scan a bill**:
  take or choose a photo.
- **Chat → … input menu → Show a photo**: a bill is recognised automatically
  and I show the same card. **Keep it as a photo instead** saves it as an
  ordinary photo memory.

The approval card works like every other: you need **Let Athena propose
changes** turned on (⋯ menu → Actions). Calendar events need Google Calendar
connected (⋯ menu → Connected apps); without it the card says there will be no
calendar event and still records the bill.

## When it doesn't work

- **"That doesn't look like a vehicle registration or property tax bill."** I
  only read those two. Try a flatter, brighter, closer photo of the page with
  the due date on it.
- **I ask which vehicle.** The bill's plate, VIN or description didn't point to
  exactly one of your vehicles. Pick one, or add the vehicle under Property →
  Vehicles first.
- **I can read the bill but can't propose.** Turn on **Let Athena propose
  changes** (⋯ menu → Actions).
- **Approve went red.** The reason on the card is the real one. If Google says
  to reconnect, do that from Connected apps; nothing was changed, so you can
  scan the bill again.

## Limits

- Only vehicle registration renewals, property tax bills (and their
  receipts) and vehicle letters, one photo at a time, adults only.
- I can't pay a bill, file anything with a county or DMV, or look up what you
  owe. I read what's on the page.
- I won't add an event in the past: a bill already overdue is recorded without
  a calendar event.
- The calendar events are all-day events on your own primary calendar, and
  never list a plate, parcel or account number. I add the due date and a
  reminder 14 days earlier (for a tax bill, each coming installment, with a
  reminder for the first); the reminder length isn't adjustable yet.
- I don't send push reminders for these. The calendar events and the Home
  banner are the reminders.
- A tax bill needs your property saved under Property → Overview first. One
  property per person.
- A vehicle tax from a receipt joins the bill's record only when the tax year
  matches; otherwise it's recorded as its own paid record.
- I can't read a bill that isn't legible; I'd rather ask than guess.
- Not yet tested on a real bill: the reading was only exercised on synthetic
  examples.

## Under the hood

**Never sent to a model.** The map for the next coding agent:

- Extraction + matching + proposal: `src/services/billScan.js` — "vision" task
  through the llm router (adult audience), flat `fields[]` with a per-field
  confidence, code validation (`parseDay`, `parseMoney`, `parseVin` with check
  digit), `matchVehicle` / `matchProperty` (never guess), `finish()` builds the
  params and calls `actions.attempt(..., { billScan: true })`. `scanIfBill()` is
  the chat-photo hook (never throws; a non-bill returns null).
- Records: `src/services/billRecords.js` — tax upsert, installment paid,
  fingerprint claim (`athena_bill_scan`), calendar drafts (`eventDrafts`),
  `promptTaxes()` for her prompt.
- Actions (owner-authorized 2026-10-28; protected `actions/` path):
  `src/services/actions/billActions.js` — `record_vehicle_bill` and
  `record_property_tax_bill` and `record_vehicle_notice` (appends one dated line to the vehicle's `notes`, 4,000-character cap; no migration). Never standing; `normalize()` refuses unless
  `ctx.billScan === true` (only billScan.js sets it), derives the calendar
  events itself (the model supplies no event text) and passes them through
  `create_calendar_event`'s own `normalize()`; `execute()` claims the bill's
  fingerprint first, writes the events, then the records, and takes the events
  back if the records fail.
- Routes: `POST /api/v1/projects/property/bills/scan|review`,
  `GET /api/v1/projects/property/taxes`,
  `PATCH .../taxes/:uuid/installments/:installmentUuid` (`{ paidOn }`),
  `DELETE .../taxes/:uuid`; chat hook in `src/controllers/companion.js`
  `rememberPhoto` (response `{ bill }`, request `skipBill`).
- Schema: `db/migrations/0102_property_taxes.up.sql` — `athena_property_tax`,
  `athena_property_tax_installment`, `athena_bill_scan` (extracted fields only,
  never the image). **Unapplied until the owner runs it**; without it Taxes and
  scanning answer 503/"isn't set up".
- UI: `../../../companion/src/components/BillScan.tsx` (drawer, result view,
  check sheet), `PropertyTaxes.tsx` (Taxes tab), `PhotoMemory.tsx` (chat),
  `PropertyVehicles.tsx` (`VehicleDeadlineBanner` now also lists unpaid tax
  installments; `Scan a bill` button), `../../../companion/src/api/propertyTaxes.ts`.
  Mock: `localStorage.mock_bill = 'check' | 'which'`, `mock_bill_photo = 'true'`.
  The Android app bundles the companion, so the phone needs an APK rebuild.
- Tests: `src/services/billScan.test.js`, `billRecords.test.js`,
  `src/services/actions/billActions.test.js`.
- Not built: push reminders (Initiative is protected; a trigger is the owner's
  decision); keeping the bill image (would use the private-bucket pattern of
  `securityMedia.js` and needs the owner's say-so first).

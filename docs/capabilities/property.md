---
id: property
title: Property
summary: I show your property details and image map beside your projects, concerns, reported issues and calculated area conditions.
where: the left menu → Property → Add property or Edit property; Report an issue in the Issues card or tab
status: live
surfaces: [companion]
audiences: [adult]
triggers: [property, property map, acreage, aerial image, property health, key areas, property details, report an issue, property issue, something broke, not working, repair, find a pro, hvac, plumbing, leak]
---

## What I can do

I show your property name, address, description, acreage, header photo and aerial
image. You can place named areas or structures on the image and draw a boundary.
Your header photo spans the top of the page, behind the title, controls and
summary cards above the tabs. The title and description sit beside Ask Athena
and weather on wider screens; they stack on smaller screens.
The summary metrics have circular icons: a house for property health, a list
for open projects, a warning triangle for concerns and a checkmark for completed work.
Below **Ask Athena**, I show the hourly weather forecast for your saved property
address, with highs and lows for the next
24 hours. It refreshes every 15 minutes while the Property page is open.
Link each area to your existing home projects and concerns to calculate its condition.
I show your ranked projects, concerns, recent project updates and projects
whose seasonal months include the current month. Your home charter — the
vision and weights you decide by — lives at the bottom of the **Edit property**
drawer, with **Read & edit** to change it.
On the overview, **Key areas** and **Issues** share a height, as do **Recent
activity** and **Seasonal focus**; a long list scrolls inside its card.
The **Utilities** tab holds the Google Nest **Thermostats** panel; electricity
and water aren't there yet.
The overview's **Up next** card shows the three highest-ranked open projects.
It matches the height of **Property at a glance** when they sit side by side.
At its bottom, **See all projects** is a text link to the Projects tab, while
**New project** is a separate button that opens the project drawer.
You can report an issue — something wrong at the house right now — with
**Report an issue**. Choose where it is (your key areas first, then Heating &
cooling, Plumbing, Electrical, Roof & exterior, Appliances, Security,
Yard / Irrigation, or Other with your own words), describe what's happening,
pick a severity (Low, Medium, High or Emergency), say when you noticed it
(Today, Yesterday or a date), add up to four photos, and leave me a note.
The most serious open issue shows as a banner across the top of Overview and
Issues, with **View details**, **Troubleshoot with Athena** and **Find a pro**.
Troubleshoot and Find a pro open a conversation with me about that issue; I
also see your open issues whenever we talk, so you can just ask. The details
drawer lets you edit an issue, mark it resolved, reopen it or delete it. Its
**Notes** section is a running log for the issue — "Left a voicemail at 8:45" —
with each note's time; web addresses and phone numbers in a note become links
you can tap. Delete a note with its ✕. I see the latest few notes on each open
issue when we talk.
The **Active issues** card counts open issues, and Recent activity lists issues
reported and resolved beside project updates.
The rounded navigation bar has icons for **Overview**, **Issues**, **Vehicles**, **Projects**, **Concerns**,
**Property Map** and **Seasonal focus**. Selecting a tab replaces the content
below the bar and highlights the tab in cyan. The selected highlight fills its
entire segment, following the bar's rounded outer edges. **Overview** shows the
summary; **Property Map** shows the full-width image map. The header and summary cards
stay visible across tabs, and the bar scrolls horizontally on small screens.
You can also move between tabs with the arrow keys, Home and End.

## Where to find it

Open **Property** in the left menu and choose **Add property**. Enter the details
and upload your images. In this drawer, click the overview image's boundary
corners in order, then **Save property**. Use **Edit property** to change details,
photos and the boundary later.

The **Key areas** card → **Manage key areas** opens a separate drawer for area
names, map positions and linked projects and concerns. Choose **New area** or
click the map to place an area, select its links, then **Save key areas**.
Clicking an existing area card or map label opens that area in this drawer.
You can also open **Manage key areas** from the **Property Map** tab.

## When it doesn't work

- If issues fail to load or save, I say so with **Retry**; a failed save keeps
  the form open with what you typed.

- If details fail to load, use **Retry**. A failed save leaves your edits open.
- Choose an image under 20 MB. I resize uploads to JPEG; unusually detailed
  images may need a smaller source image.
- An area without linked records is **Not assessed**. Link its projects or concerns.
- Weather needs a saved address. If I cannot locate it, the forecast service
  is unavailable, or it is outside US coverage, I show **Weather unavailable**
  with **Retry** rather than guessing.

## Limits

I currently support one property per person. This is an uploaded image map,
not a satellite service or a legal survey. Replacing the overview image clears
its pins and boundary. Images are saved with your account's property details.

An issue is a dated report, not a monitored sensor: I don't watch your
thermostat or send you updates about an issue, and I don't book or call a pro —
Find a pro asks me to look one up, and you make the call. If anyone is in
danger, call 911 first; the form says so when you choose Emergency. Photos are
stored with the issue; leave children out of them.

The **Property health** card reflects active issues only: **Good** with none
open, **Needs attention** when the worst is Low or Medium, **At risk** for High
and **Emergency** for Emergency. Its note names the issue, or how many are open
and the worst one. Concerns and key areas don't decide it — they describe
standing problems and planned work, not what's wrong today.

Key area conditions on the **Key areas** card are indicators from records, not
inspections. Unresolved linked concerns of severity 4 or 5 mean **At risk**. An
open High or Emergency issue whose place matches an area's name puts that area
**At risk**; a Low or Medium one means **Needs attention**. Other unresolved
concerns, blocked work, or overdue unfinished work mean **Needs attention**.
Otherwise an area with linked records is **On track**. Concerns linked to an
area's projects also count.

Recent activity shows project updates, not a complete audit trail. Seasonal focus
uses existing project seasonal months. The **Vehicles** tab keeps the cars at
this property (see Vehicles). Otherwise I do not add asset inventories, recurring
maintenance, documents or finances here.
Weather is an hourly forecast, not a live thermometer. I use Google Maps to
locate the saved address and the US National Weather Service to retrieve its
forecast; forecasts may be cached for up to 30 minutes.

## Under the hood

- UI: `../../../companion/src/components/Property.tsx`, `../../../companion/src/components/Dashboard.tsx`.
- Navigation/drawer convention: `../../../companion/src/components/ActionControls.tsx` and `../../../companion/README.md`; shared text links for navigation and bordered drawer buttons, also used by the Projects board.
- Conditions: `../../../companion/src/components/propertyHealth.ts`; categorical bars indicate the condition, not a measured percentage.
- Weather: `src/services/propertyWeather.js`, reusing `src/services/travel.js` and `src/services/weather.js`; GET `/api/v1/projects/property/weather` reads only the authenticated adult's saved address.
- Tests: `src/controllers/properties.test.js`, `../../../companion/scripts/propertyHealth.test.mjs`.
- API: `src/controllers/properties.js`, `src/routes/projects.js`; GET/PUT `/api/v1/projects/property`.
- Schema: `db/migrations/0072_properties.up.sql`; UUID primary key and a unique profile index enforce one property today.
- Images: resized JPEG data in the profile-scoped details record, not public URLs.
- Issues UI: `../../../companion/src/components/PropertyIssues.tsx` (report/edit drawer, banner, list, details), `../../../companion/src/api/propertyIssues.ts`; mock in `../../../companion/mock/projects.ts`.
- Issues API: `src/controllers/propertyIssues.js` — GET/POST `/api/v1/projects/property/issues`, PATCH/DELETE `/:uuid`, GET `/:uuid/photos`; adult-only, profile-scoped, every write returns the whole list. Tests: `src/controllers/propertyIssues.test.js`.
- Issues schema: `db/migrations/0075_property_issues.up.sql` — `athena_property_issue` plus `athena_property_issue_photo` (JPEG data URLs, at most four, kept apart so listing never carries image bytes).
- Issue notes: POST `/api/v1/projects/property/issues/:uuid/notes`, DELETE `/:uuid/notes/:noteUuid`; returned on each issue as `log`. Schema `db/migrations/0077_property_issue_notes.up.sql`; before it is installed issues list without notes.
- Issues in her prompt: `src/services/projects/prompt.js` reads open issues through `openIssues()`; read-only, never throws.
- Not built: the mockup's "Notify me about updates" — Athena speaking first is the protected initiative service (`src/services/initiative/`), and a new trigger is the owner's decision.

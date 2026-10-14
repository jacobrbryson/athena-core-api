---
id: property
title: Property
summary: I show your property details and image map beside your projects, concerns, and calculated area conditions.
where: the left menu → Property → Add property or Edit property
status: live
surfaces: [companion]
audiences: [adult]
triggers: [property, property map, acreage, aerial image, property health, key areas, property details]
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
I show your ranked projects, concerns, charter, recent project updates and projects
whose seasonal months include the current month.
The overview's **Up next** card shows the three highest-ranked open projects.
It matches the height of **Property at a glance** when they sit side by side.
At its bottom, **See all projects** is a text link to the Projects tab, while
**New project** is a separate button that opens the project drawer.
The rounded navigation bar has icons for **Overview**, **Projects**, **Concerns**,
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

Area conditions are indicators from records, not inspections. Unresolved linked
concerns of severity 4 or 5 mean **At risk**. Other unresolved concerns, blocked
work, or overdue unfinished work mean **Needs attention**. Otherwise an area
with linked records is **On track**. Concerns linked to an area's projects also
count. Overall health takes the most serious area condition; incomplete
assessment shows **Not assessed** if no assessed area needs attention.

Recent activity shows project updates, not a complete audit trail. Seasonal focus
uses existing project seasonal months. I do not add asset inventories, recurring
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

---
id: text-reading
title: Reading your texts
summary: On the Android app I can read your Google Messages texts, offer to put plans on your calendar, and summarize long texts with a reply you can send.
where: the ⋯ menu → Initiative → read my texts (Android app only)
status: partial
surfaces: [companion]
audiences: [adult]
triggers: [my texts, text messages, read my texts, incoming texts, google messages, suggested reply, suggest a reply, summarize texts, long text, text reminder, add it to my calendar from a text]
---

## What I can do

On the Android app, with your permission, I read the texts that arrive in **Google Messages**. Two things can come of one:

- **A plan for your calendar.** If a text mentions an upcoming event, appointment or deadline that isn't on your calendar, I send you a notification asking whether to add it. If it's already there but missing the address or a detail the text gives, or the text says it moved, I ask whether to update it. Tap **Add** (or **Update**) or **No thanks** right on the notification. Nothing changes until you tap, and I tell you when it's done.
- **A long text.** If a text is long (about 250 characters or more), I send a short summary and a suggested reply. **Reply in Messages** opens that conversation with my reply already typed in, so you can edit it and press send yourself. **Copy** copies it. I never send a text for you.

I don't keep your texts. I keep only what I suggested, for a week, and a note of whether each text led to anything. One-time codes never leave your phone, and neither do phone numbers.

## Where to find it

In the Android app: the **⋯ menu** → **Initiative** → **read my texts** → **Let me read my texts**. Android opens its Notification access screen, where you switch on **Athena — read my texts**. That line is separate from the PulsePoint alerts line. Initiative has to be on, because these are things I raise first. Calendar suggestions also need Google Calendar connected, with permission for me to propose changes.

To stop, switch **Athena — read my texts** off on that same Notification access screen.

## When it doesn't work

- **"allowed, but Android isn't running my reader"**: Android stopped the reader (battery saver, an update). Opening Athena asks Android to restart it. If that doesn't help, switch it off and on in Notification access, and set Athena's battery use to **Unrestricted**.
- **The switch is greyed out ("Restricted setting")**: open Athena's app info, tap **⋮** → **Allow restricted settings**, then try again.
- **Nothing at night**: during your quiet hours I hold these notifications until the morning, the same as everything else I raise first. Nothing is lost.
- **Reply in Messages only opened the conversation**: when I couldn't see the other person's number (group chats, or some contacts), I copy the reply and open the conversation instead. Paste it in.

## Limits

- Google Messages on the Android app only. No other texting apps, and not on iPhone or in the browser.
- I only see texts that arrive while the reader is running, and texts from the last day.
- I can't send, reply to, delete or mark a text as read. The reply is always yours to send.
- I only add to, and update events on, your own calendar, never a shared one, and I never add guests.
- Muting just one kind of these isn't possible yet. Turning the reader off in Notification access stops both.
- A suggestion I made expires if you don't answer it: a day for calendar ones, twelve hours for replies.

## Under the hood

**Never sent to a model.**

- Backend: `src/services/textMessages/index.js` (ingest → one `llm.generateJson` "extract" call → calendar match → `athena_text_suggestion` + an `athena_nudge` row, triggers `text_calendar` / `text_reply`), `src/controllers/textMessages.js`.
- Push: `src/services/push/index.js` `deliverNudge` asks `textMessages.pushFor(nudgeUuid)` for the title and buttons on every `text_*` nudge, so initiative's `releaseHeld` (quiet hours) sends the buttons too, and skips suggestions that are already decided.
- Action: `update_calendar_event` in `src/services/actions/registry.js` (primary calendar only, location/description/time, never standing) → `googleCalendar.getEvent` / `updateEvent` (PATCH, `sendUpdates: none`). Adds use the existing `create_calendar_event`.
- Approval: nothing is proposed at ingest. `decide()` runs `actions.attempt` and then `actions.confirm` when the person taps, so the tap is the recorded human approval.
- Routes: `POST /api/v1/dashboard/texts/incoming` (device token only), `POST /api/v1/dashboard/texts/suggestions/:uuid/{approve,decline,used}`, `GET /api/v1/dashboard/texts/recent`.
- Migration: `db/migrations/0117_text_messages` (`athena_text_message`, `athena_text_suggestion`).
- Android: `../../../native-runtime/AndroidCompanion~/AthenaDashboard.androidlib/java/com/orcwood/athena/dashboard/TextMessageListener.java` (its own NotificationListenerService; Google Messages only; drops one-time codes; the number stays in `TextThreads`), `TextNotifications.java`, `TextReplyActivity.java` (copy + `smsto:` with `sms_body`, falling back to the conversation's own contentIntent, then the app), `NotificationActionReceiver.java` (approve/decline), `AthenaPushService.java` (kinds `text_calendar` / `text_reply`).
- Frontend: `../../../companion/src/components/TextReadingSetup.tsx` (inside `InitiativePanel.tsx`), hook `useTextReading` in `../../../companion/src/athena/useAndroidPush.ts`.
- Tests: `src/services/textMessages/textMessages.test.js`, `src/services/actions/updateCalendarEvent.test.js`.
- Notes: a mute of `text_calendar` / `text_reply` is honored, but `initiative.mute()` validates against the protected trigger registry, so there is no way to set one yet. RCS texts never reach Android's SMS broadcast, which is why this reads the notification.

# YouTube Music

**Status: design only (2026-11-21). Nothing here is built.** Instant-path
approval decided by the owner the same day: option A. Open questions are
marked **OPEN** and collected at the end. Decisions that change the action
layer (protected) are the owner's and are marked **OWNER**.

Athena controls the YouTube Music app on the owner's phone and learns which
songs they like *in which situation*, so "play my running music" or "play
something for the drive" plays the right thing. The two cases that matter most
are **on a run** (hands-free, earbuds) and **in the car**. In both, the goal is
to be noticeably faster than Gemini on Android Auto.

## What it is (and is not)

- **Athena is a remote control and a memory, not a player.** YouTube Music
  stays the player: the owner's account, Premium, downloads and background
  play stay where they are. No streaming through Athena, no unofficial API, no
  stored YouTube cookies.
- **Android only.** It works through Android's media-session API, which shows
  what any app is playing and lets another app press its buttons. Nothing on
  the web or desktop companion.
- **No listening log.** Athena does not record everything you play. She stores
  a song only when you say you like it, and a skip only while she is playing
  one of her situational playlists (to learn from it). "What's playing?" is read
  on demand and not kept. Learning a person's taste is welcome; watching
  everything they listen to is the thing the mission says not to do.
- **Adults only**, per profile. Children's profiles never get it, and their
  listening never enters `athena_mind`.

## The four pieces

### 1. Now playing + controls

The phone reads YouTube Music's active media session through
`MediaSessionManager.getActiveSessions()`. That call needs a notification-listener
component. The app already has two (`TextMessageListener`, `PulsePointListener`),
so it uses the existing permission and adds no new consent screen. It is
granted per component, so it uses whichever listener is already enabled.

| Ask | What happens |
|---|---|
| "What's this song?" | Title, artist and album from the session's metadata, said out loud |
| "Skip" / "next" | `transportControls.skipToNext()` |
| "Back" / "play that again" | `skipToPrevious()` |
| "Pause" / "stop the music" | `pause()` |
| "Resume" / "play" | `play()` |
| "Louder" / "quieter" | Media volume up/down one step (`AudioManager`), not the session |

Only YouTube Music's session is controlled (package `com.google.android.apps.youtube.music`).
If another app is playing, Athena says so and does nothing. **OPEN:** should
it control any active player (Spotify, podcasts)? That's easy to widen later,
and I'd start narrow.

### 2. Speed: the instant path

Gemini is slow because every command goes to the cloud and a full model.
Hands-free and conversation mode already transcribe the request **on the
phone** (`HandsFreeService`: Vosk or Android's on-device recogniser). So:

| Kind of ask | Path | Target, end of speech → effect |
|---|---|---|
| Fixed verbs: skip, next, back, pause, resume, louder, quieter, what's this song | Matched on the phone against a small fixed list of phrases, before anything is sent | **< 300 ms** |
| "Play my running music", "play some Tool" | Jev intent guesser (~0.2 s) → server → silent FCM → phone | < 1.5 s |
| Anything conversational ("what's this song about?") | Normal chat | as today |

The fixed list is exact phrases only ("skip", "skip this", "next song",
"pause the music"…), not fuzzy. Anything that doesn't match exactly goes to
the server as it does today. A wrong local match costs a skipped song; a
missed one costs a second.

**OWNER: how the instant path is approved.** Every action today is proposed,
approved and audited on the server before it runs (`services/actions/index.js`,
four gates). The instant path can't wait for the server, so one of these has
to be chosen:

- **A. Phone acts under a cached standing approval, then reports.** When the
  owner grants the standing approval for `media_control`, the phone is told
  and keeps a copy. Revoking it pushes a revoke. On a local match the phone
  acts, then posts the audit row (action, params, time, "standing", authority
  id). The server records it and flags it if the authority wasn't live at that
  moment. Fastest. The cost is that the record lands just after the action
  instead of before, and the phone briefly holds a decision the server
  normally holds. Limited by code to the six verbs above, which are
  harmless and undone in one word.
- **B. Everything goes through the server.** Local match → server propose →
  standing execute → FCM back to the phone. No change to the action layer, but
  it's a network round trip both ways, likely 1–2 s on mobile data, roughly
  Gemini speed. That loses the main win.
- **C. Media keys aren't actions.** Treat them like the phone's own volume
  buttons: no action row, just an activity log. Simplest, but it's an
  exception to "everything Athena does is an action", which is the kind of
  exception the gate exists to prevent. **Not recommended.**

**Decided: A, by the owner on 2026-11-21.** Written so that it cannot grow. The phone-side list of
allowed verbs is a constant in code, the server rejects any phone-reported
action not in that list, and only `media_control` can ever take this path.
Because it changes the propose → confirm → audit sequence, it needs the
owner's explicit instruction. Self-improvement may never widen it.

### 3. Songs you like, by situation

**Saving.** "I love this song", "save this one", "this is a good running song".
The phone reads the current track and the server stores it with the situation
Athena can see at that moment. Nothing to tag by hand.

Situations, from signals Athena already has:

| Situation | Signal |
|---|---|
| `running` | WHOOP workout in progress, or heart rate high + walking/running speed from location |
| `driving` | Car conversation mode on / car Bluetooth connected (`CarAudio`), or driving speed |
| `workout` | WHOOP workout, not moving (gym) |
| `focus` | A work block on the calendar, at the desk |
| `evening` | Home, after 7 PM, no event |
| `general` | None of the above |

The person can always override in words ("save this for the drive"). The
stored situation is a guess plus the signals behind it, so a wrong guess can
be corrected ("no, that's a running song").

**Table** (main DB, migration TBD):

```
athena_music_like
  id, profile_id, title, artist, album, yt_video_id (nullable),
  situation, signals_json, said (the words used), created_at, removed_at
athena_music_skip
  id, profile_id, like_id, situation, played_ms, created_at
```

"Forget that song" sets `removed_at` and takes it out of the playlist. This is
Athena's structured data, like `athena_workout`. It is **not** a memory in
`user_memory`, though she may mention it in chat ("you saved six running songs
this week").

**Saving is not an action** (no external effect, like her own notes). Putting
the song on a YouTube playlist is, see below.

### 4. Situational playlists

**The plan.** Athena keeps one real playlist per situation in the owner's
YouTube account: "Athena · Running", "Athena · Driving", and so on. A saved
song is added to its playlist through the YouTube Data API
(`playlistItems.insert`). "Play my running music" starts that playlist in
YouTube Music. The owner can see and edit these playlists in YouTube Music
too, and anything they remove there is removed here on the next sync.

**Starting a playlist: unverified.** This is the main technical risk, and the
spike (phase 0) tests it first. In order of preference:
1. `transportControls.playFromMediaId()` / `playFromSearch()` on YouTube
   Music's own session. It supports Android Auto browsing, so it likely
   implements these.
2. A deep link `music.youtube.com/playlist?list=…` opened into the app. This
   may open the page without playing.
3. `MEDIA_PLAY_FROM_SEARCH` with the playlist name. This might find a public
   playlist instead.

If none of these starts playback hands-free, phase 3 falls back to "play
some X" by search only and situational playlists wait.

**Finding the video id.** The session's metadata gives title and artist.
`METADATA_KEY_MEDIA_ID` *may* be the YouTube video id (**OPEN**, spike). If it
isn't, a `search.list` lookup finds it (100 quota units each; 10,000/day is
~100 saves a day, plenty).

**Google consent.** Writing playlists needs the `youtube` scope, which is
broad (it can also delete videos and playlists). It is **not** added to the
Google sign-in group for everyone. It's requested on its own, only when the
owner turns on situational playlists, and the connector only ever touches
playlists Athena created (it keeps their ids). **OPEN:** whether the OAuth
app's verification status allows adding this scope without a new Google review.

**Skip learning.** While an Athena playlist plays, a skip in the first 30 s
is recorded against that song and situation. Three early skips in one
situation and Athena proposes moving it ("You keep skipping *X* on runs. Take
it off the running list?"). Removing it is a card, never automatic: the
learning informs and never deletes by itself. Skips outside Athena's playlists
aren't recorded.

## Actions (registry descriptors to add)

| id | What | reversible | standing | Notes |
|---|---|---|---|---|
| `media_control` | play / pause / next / previous / volume up / down | yes | **yes** | The only action eligible for the instant path (OWNER: option A) |
| `play_music` | Start a situation playlist, or a search ("Tool") | yes (pause) | yes | Server → silent FCM → phone |
| `music_playlist_add` | Add a saved song to its YouTube playlist | yes | yes | Fires after a save when standing; otherwise one card |
| `music_playlist_remove` | Take a song off a playlist | yes | yes | Skip-learning proposals land here and always ask first, even with standing |

All are `availableTo` adults whose phone has registered the media capability.
`normalize()` accepts only the enumerated verbs, a situation key from the
fixed list, and a search string ≤ 100 chars. `media_control` never accepts a
package name: the target app is fixed in phone code.

## Car specifics

- **The Bluetooth call link may pause music. Test this first.** Car
  conversation mode keeps the phone in communication mode over the car's
  hands-free link for as long as it's on (`CarAudio`). Many cars pause or mute
  media audio while that link is up. If they do, "conversation mode + music"
  can't coexist. Wake-word hands-free in the car would then need to open the
  call link only for the duration of each turn, then hand audio back. That is
  a change to `CarAudio`'s whole-session design and needs a spike in the
  owner's actual car.
- **Android Auto. OPEN.** If the phone is projecting Android Auto, does it
  hold the microphone and block Athena's wake word? Control itself is fine
  (YouTube Music is still the session either way). Needs a test in the car.
- Spoken replies in the car are a few words, never a list ("Skipped." /
  "Playing your driving list.").

## On a run

- Works with hands-free (wake word) as it is today. Earbuds' own buttons keep
  working independently.
- Heart-rate announcements and music ducking (`AthenaVoice`) already exist.
  Now-playing info only enters what she says when asked.

## Capability file

Per AGENTS.md: `core_api/docs/capabilities/youtube-music.md` + a LEDGER line,
written with phase 1 and extended each phase, so Athena knows what she can and
can't do ("I can't open a specific album, but I can play it by search").

## Phases

| Phase | What | Where | Ships |
|---|---|---|---|
| **0. Spike** | On the S25, no server: read YouTube Music's session, try every control, try the three ways of starting a playlist, check whether `MEDIA_ID` is a video id, test the call link vs music in the car, test Android Auto vs the wake word | Phone, throwaway | Findings, written into this doc |
| **1. Controls** | Now playing + `media_control`, instant path (if A) or server path (if B), capability file | Phone + action registry | APK rebuild |
| **2. Saving** | "Save this song", situation inference, tables, "forget that song", chat can list them | Server + phone | Deploy + APK |
| **3. Playlists** | YouTube scope, Athena playlists, `play_music`, `music_playlist_add`, two-way sync | Server + connector | Deploy (APK only if playback start needs it) |
| **4. Skip learning** | Skip records on Athena playlists, removal proposals | Server + phone | Deploy + APK |

Phases 1 and 2 are useful on their own, even if phase 0 shows playlists can't
start hands-free.

## Open questions

1. ~~**OWNER:** Instant path: A, B or C?~~ **Decided 2026-11-21: A** (phone
   acts under a cached standing approval for `media_control`'s six verbs, then
   reports the audit row).
2. **OWNER:** Control YouTube Music only, or any player?
3. **OWNER:** Should a save add to the YouTube playlist under a standing
   approval (silent), or ask each time?
4. Does YouTube Music start a playlist from another app without a tap? (spike)
5. Is `METADATA_KEY_MEDIA_ID` the YouTube video id? (spike)
6. Does the owner's car pause music while the call link is up? (spike, in the car)
7. Does Android Auto block the wake word? (spike, in the car)
8. Can the `youtube` scope be added to the OAuth app without a new Google
   verification review?
9. Situation list: are running / driving / workout / focus / evening / general
   the right set, or does the owner want others (cooking, kids in the car)?

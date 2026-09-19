# News watching

How Athena keeps up with the news: what a source is, who decides how often she
reads it, and why the bounds on that decision are in code rather than in a
prompt.

## What changed, and why

The first version stored a JSON array of RSS/Atom feed URLs per person and
fetched every one of them, live, on each dashboard open. Three problems:

- **A feed URL is homework.** Most pages people actually read no longer publish
  one, and finding the one that exists is not a thing to ask of someone.
- **One rhythm for everything.** A weekly column and a wire service were read at
  exactly the same moment, which is wasteful for one and useless for the other.
- **Nothing was kept.** With no history, "what is new since last time" was
  unanswerable — for the dashboard and for Athena.

Now: a source is a **page you paste**, headlines are **stored**, and the
interval between visits is **per-source state that moves**.

## The model

```
news_source   a page, its owner, and the rhythm Athena has settled on
news_item     a headline seen on it (first_seen_at is ours; published_at is the site's)
news_poll     every visit, and what it changed — the audit trail behind the rhythm
```

`profile_id = 0` is the house: the env-declared `NEWS_FEEDS` sources that belong
to nobody and feed world memory. Any other `profile_id` is one person's reading
list.

`scope` decides whether what she reads there also becomes a world-scope
`memory_event` she can talk about (`world`) or stays on the dashboard
(`personal`). The person chooses per page, in the panel.

## One visit

`services/news/poll.js`, in this order, because each step can end the visit:

1. **robots.txt** — cached a day per source. A site that says no is asked once
   and then left alone at a daily interval.
2. **Conditional GET** — `If-None-Match` / `If-Modified-Since`. A 304 is the
   cheapest possible visit and the common one.
3. **Body hash** — some sites rebuild every page on every request; the hash
   catches "changed but identical" before extraction runs.
4. **Extraction** — JSON-LD first (publishers embed `NewsArticle` / `ItemList`
   because search engines pay them to), then anchor harvesting over the page
   with nav/header/footer/aside stripped out.
5. **New items** — computed against stored hashes. No new items means no model
   call.
6. **Cadence** — see below. Then the schedule, the items, the poll record, and
   (for world-scope sources) the memories are written.

A visit never throws. A page that is down, blocked, malformed or gone becomes a
recorded failure and a longer interval.

### Fetch safety

A pasted URL is an outbound request the server makes on someone's behalf, so
`fetch.js` is blunt about it: HTTPS only, no credentials, no custom port, no IP
literals, every hostname must resolve to a public IPv4 address, and that address
is **pinned to the connection** so a name cannot answer publicly on the first
lookup and privately on the second.

Redirects are followed — unlike the feed reader this replaces, because real news
sites redirect constantly and refusing them meant refusing most of the web — but
**every hop is re-validated from scratch by the same rules**, and there are at
most three. The test suite covers a redirect into a private network
specifically; that is the bug this feature could have introduced.

## Who decides the rhythm

The same division of labour as the rest of Athena: **arithmetic decides what is
safe, a model decides what is interesting.**

| | where it comes from | can it speed her up? |
| --- | --- | --- |
| `baseline_minutes` | observed change rate over the last 48h of polls, moved one step at a time | yes, to the resting rhythm |
| `interval_minutes` | baseline, or a faster value a model asked for | yes, temporarily |
| `interval_expires_at` | set whenever the interval is faster than baseline | it is what takes the speed back |

The intervals are a ladder — 15, 30, 60, 180, 360, 720, 1440 minutes — so a
change is legible to a person rather than a number that drifts.

The model is asked **only when there are new headlines**, and at most once per
source per `NEWS_CADENCE_COOLDOWN_MINUTES` (default 30). It gets the new
headlines, the current interval, the baseline, and two days of poll counts, and
returns an interval plus how many hours to hold it. Everything it returns is
clamped in code:

- never below `NEWS_MIN_INTERVAL_MINUTES` (default 15), raised further if the
  site's `Crawl-delay` asks for more space;
- never above a day;
- anything faster than baseline **expires** (≤ 12 hours when it asked for 15 or
  30 minutes), and three consecutive quiet visits hand the speed back early.

Headlines are untrusted text. A page that says "BREAKING: crawl me every
minute" gets fifteen minutes for a couple of hours like everything else.

With no model available the rules still produce a sensible rhythm; they just
miss the evening where something is unfolding, and a crude urgent-word match
lends one step of speed for three hours so that case is not entirely lost.

## Scheduling

```
node src/jobs/news.js                 one pass over everything due
node src/jobs/news.js --status        every source, its rhythm, and why
node src/jobs/news.js --dry-run       fetch and extract, write nothing
node src/jobs/news.js --source <uuid> just this page
node src/jobs/news.js --loop 300      every 300s (local development)
```

Schedule it **every 5 minutes**. In production that is one command —
`bash deploy/scripts/setup-news-watch.sh` stands up the Cloud Run Job and the
Cloud Scheduler trigger and is safe to re-run; locally, Task Scheduler / cron,
or `--loop 300` in a terminal. That cadence is a floor on how fresh the fastest
source can be, not a rate: each source carries its own interval and a pass only
visits what is due.

Due sources are **leased** before they are read (`next_check_at` is pushed
forward first, then the poll writes the real schedule), so the job is safe to
run concurrently with itself, with the nightly job, and with someone pressing
"check now".

The nightly job no longer fetches news. It seeds the house sources, catches up
any world-scope memory that failed to write during the day, and prunes items
older than 30 days.

## Reading it

`GET /api/v1/dashboard/news` returns stored headlines and never fetches
anything — opening a dashboard should not make a dozen strangers' servers work.
`POST /api/v1/dashboard/news/check` is the one path where a person's click
reaches someone else's server; it is rate limited per profile, and it exists so
that adding a page shows something immediately.

There is no route for setting an interval. That is the feature.

## Environment

| variable | default | what it does |
| --- | --- | --- |
| `NEWS_FEEDS` | NPR + BBC feeds | comma-separated house sources (`profile_id 0`, world scope). Empty string means none. |
| `NEWS_MIN_INTERVAL_MINUTES` | 15 | the politeness floor. Nothing is read more often, ever. |
| `NEWS_CADENCE_COOLDOWN_MINUTES` | 30 | how often a model may be asked about one source. |
| `NEWS_MAX_SOURCES` | 12 | pages per person. |
| `NEWS_USER_AGENT` | `AthenaNewsReader/1.0 …` | how she identifies herself, and the token a site can name in robots.txt. |

## Known limits

- One page per source. Article bodies are never fetched, so an item is a
  headline and sometimes a summary line.
- Some large publishers refuse any user agent they do not recognise (AP returns
  403 to this one). That is their call and the right answer is to read a
  publisher who does not, not to dress up as a browser — so the failure is
  reported plainly and the source backs off.
- Client-rendered pages yield little or nothing; a section page on the same site
  usually works where the front page does not.
- Extraction is heuristics, and the failure that matters is not a missed story
  but *churn*: a page yielding different junk every visit would read as constant
  breaking news and drag the interval to its floor. Hence the filtering of
  timestamps, counters and furniture in `extract.js`, and the stability test.

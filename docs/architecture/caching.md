# Read caching

## Plan and implemented scope

1. Reuse the shared connector HTTP layer to cache existing bounded provider GETs.
2. Persist encrypted read results in MySQL; add bounded process memory and
   in-process request coalescing in front of the payload table.
3. Reuse validated model card orderings by profile, prompt version and exact
   input signals. Keep generation in the existing guarded LLM adapter.
4. Add a shared, dependency-free Companion browser read store with expiry,
   coalescing and invalidation. This is server-data caching, so it does not
   require replacing the existing React state with Redux.

The feature covers Calendar, WHOOP, Strava, Gmail, Jira and Slack reads through
an explicit path allowlist. Calendar's old account-insensitive list cache was
replaced by this shared cache. Family Chores, Guardian mission state, chat,
actions, identity, access decisions and initiative are not newly cached.
News already has persistent reading/storage and conditional HTTP fetching;
its browser read participates without introducing another server fetch cache.

## Freshness and keys

| Layer | Lifetime | Bound/key |
| --- | --- | --- |
| Provider database payload | 30 seconds | profile, provider, canonical URL/query, token fingerprint, actor, HTTP failure policy, generation |
| Model card ordering | 10 minutes maximum | profile, versioned prompt and exact current signal sheet, generation |
| API payload memory | 5 seconds, capped by payload expiry | 128 entries, 256 KiB per serialized value |
| API in-flight sharing | request duration | 128 tracked requests per process |
| Companion dashboard reads | 15 seconds | tab-local request path; reset at session boundaries |
| Companion memory/in-flight | as above | 64 retained results and 64 tracked requests |

WHOOP and Strava lookback boundaries round down to 30 seconds (at most 30
seconds of extra lookback) so repeated reads have identical query keys.
Calendar keeps its existing local-day windows. Query parameters otherwise
retain their exact meaning. Card timing signals change as minutes pass, so a
ten-minute maximum does not imply every ordering remains reusable that long.

TTL does not schedule a poll. The dashboard still polls every five minutes,
refreshes when returning after that interval, and responds to server pushes.
Layer lifetimes can add: a just-fetched browser copy can contain a provider
read nearly 30 seconds old. No stale-on-error fallback is used. Section
`checkedAt` is the dashboard assembly/check time, not an upstream fetch time.

## Access, invalidation and failures

Routes keep their live access checks. Every connector cache lookup follows
the existing OAuth credential read/refresh/audit; it never caches that decision.
The existing caller consent checks remain in place. Tokens are hashed into
the key, never persisted in plaintext. Payloads use the existing authenticated
encryption/keyring helper. Keys and counters do not contain response text.

Non-GET provider requests are not cached or coalesced. They rotate a database
generation before and after execution, including ambiguous failures. Every
cached read checks that generation in the database, even on a memory hit.
Other instances and old in-flight fills therefore cannot repopulate the active
generation. This deliberately retains a small DB read to prevent cross-instance
invalidation from depending solely on a local process map. Cold misses can
still duplicate provider work across separate processes; there is no distributed lock.

Missing tables, failed cache queries, corrupt ciphertext, unavailable encryption
and oversized payloads fall back to live loading. Provider/model errors do not
become cache entries. Failed invalidations are counted; if cache infrastructure
fails during a write, cross-instance freshness is bounded by the old TTL rather
than an immediate invalidation guarantee. The cache never authorizes a write.
Upstream revocations that Athena has not yet observed may take the provider
TTL to be detected; locally disconnected credentials cannot reach the cache.

Browser mutations clear memory before and after sending, even on failure.
Session/profile loading, access/session errors, server dashboard pushes,
page restoration and hidden tabs clear it too. BroadcastChannel clears copies
in other open tabs. Responses started before a clear are rejected, not stored
or published. No private result is written to browser disk. Routine refreshes
keep existing cards visible; errors and push invalidation clear them. Updates
received during an active refresh queue another pass instead of being dropped.

## Rollout and operations

Apply `0034_read_cache.up.sql` using the existing reviewed migration process,
then deploy the API and Companion together. No new dependency is required.
Without this migration requests still work but server caching is bypassed.
The runtime needs ordinary SELECT/INSERT/UPDATE/DELETE on the two cache tables;
this change does not alter deployment permissions or grant runtime DDL rights.

Set `READ_CACHE_DISABLED=true` to bypass server cache reuse. Browser reuse
expires in 15 seconds or clears on reload. The down migration removes only the
two disposable cache tables. Do not roll back any unrelated pending migration.

Expired payloads are never served. Successful fills prune up to 1,000 expired
rows once per minute per process using an expiry index. On idle installations
expired encrypted rows remain until later traffic or operator cleanup. For
strict retention, schedule a database maintenance job to delete expired rows:

```sql
DELETE FROM read_cache
WHERE expires_ms <= UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
LIMIT 1000;
```

Repeat in bounded batches. For account erasure, remove that profile's rows from
both cache tables as part of the operator's erasure procedure. Scope generation
rows are small and persist to prevent an old generation becoming active again.
Key rotation does not require re-encrypting these disposable short-lived rows:
an unreadable value becomes a miss. Database backups retain their own retention.

`require('./src/services/readCache').stats()` provides process-local memory hits,
database hits, misses, shared requests, oversized bypasses, cache failures,
entry count and in-flight count without exposing private payloads. Inspect in
the running process, not a fresh CLI process. Compare provider request counts
and dashboard p50/p95 latency after rollout; no production speedup is claimed
from unit tests alone.

## Validation

Run Jest for readCache, connectors, dashboard, dashboardPriority and selfKnowledge.
Tests cover isolation, expiry, restart persistence, invalidation across instances
and in-flight fills, bounded memory, failed loads, live credential checks and
uncached writes. Companion: `npm run test:cache`, `npm run typecheck`, `npm run build`.
The cache tests use an in-memory SQL adapter; they do not validate a live MySQL
migration or measure production provider latency.

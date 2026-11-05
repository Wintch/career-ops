# Shared fetch: one reader for the job sites, many people's scans

Several people on one machine each run a scan, and each scan asks the same job
sites for the same boards. That is wasted work and one IP knocking on the same
door once per person, which is how a site starts to block it. The fix is one
fetcher that reads each board once and keeps the response, and scans that parse
what it kept. No person's data is involved: the store holds public postings only.

## Measured (2026-11-05)

| What | Result |
| --- | --- |
| Full scan of 221 companies and 32 boards, store hot | 225 of 253 sources done in **6 s** |
| Same scan, wall time | **11 min**: NVIDIA's Workday board alone made 559 requests (528 s of the 937 s of requests), because Workday answers `Cache-Control: no-store` and the cache refuses to keep it |
| 6 boards through the shared flow: fetcher | 74 s, 68 responses stored (5.5 MB) |
| The same 6 boards, a reader in cache-only mode | 13.5 s, **0 network requests**, identical result (1480 postings, 49 new) |

## Roles

**Fetcher.** One checkout with its own data root, never a person's. It runs the scan
over the union of what the people scan and stores every response.

```bash
node union-portals.mjs --from /people/a/portals.yml,/people/b/portals.yml --out /fetcher/portals.yml

CAREER_OPS_ROOT=/fetcher \
CAREER_OPS_HTTP_CACHE_DIR=/shared/http-cache \
CAREER_OPS_HTTP_CACHE_TTL_MS=108000000 \
CAREER_OPS_HTTP_CACHE_STORE_NO_STORE=1 \
node scan.mjs --quiet
```

Its own `data/pipeline.md` is a by-product and can be ignored. Rebuild the union
whenever a person's `portals.yml` changes (`select-portals.mjs` writes it).

**Reader.** Each person's scan, as it runs today, with the store mounted read-only:

```bash
CAREER_OPS_HTTP_CACHE_DIR=/shared/http-cache \
CAREER_OPS_HTTP_CACHE_TTL_MS=108000000 \
CAREER_OPS_HTTP_CACHE_ONLY=1 \
node scan.mjs        # or scheduled-chain.mjs, which runs it
```

## Variables

| Variable | Fetcher | Reader | Meaning |
| --- | --- | --- | --- |
| `CAREER_OPS_HTTP_CACHE_DIR` | store path | store path (read-only mount) | Where responses live. Default: `<data root>/data/cache/http`, one per person |
| `CAREER_OPS_HTTP_CACHE_TTL_MS` | 30 h | 30 h | How long a response counts as fresh. Default 15 min, which suits one scan and not a shared store |
| `CAREER_OPS_HTTP_CACHE_STORE_NO_STORE` | `1` | unset | Also keep a body the server marked `no-store` (measured on Workday) |
| `CAREER_OPS_HTTP_CACHE_ONLY` | unset | `1` | A request that is not fresh in the store fails without touching the network |

A 30 h window outlives a daily fetch by six hours. If a night's fetch fails, readers
get a clear miss, not silently stale postings.

## What a reader reports

A board missing from the store is not fetched. That source ends with
`not in the shared fetch store (cache-only mode)` and the scan prints
`N requests were not in the shared fetch store and were not made`. Treat N as the
signal to rebuild the union. Two causes besides a stale union:

- A few providers build their requests from the title keywords (`title_filter.positive`).
  The union carries every person's keywords, but a provider that joins them into one
  request still produces a different request per person, so those misses are expected.
- A person whose entry asks for something the union did not (another `max_pages`, a
  different filter block) is a different request.

## What the store does not cover

Only requests made through `fetchJson` and `fetchText` go through it, which is nearly every
board provider. These do not:

- `scan-navent.mjs` (Bumeran and ZonaJobs, a browser) and `scan-interamt.mjs`.
- `scan-ats-full.mjs`: a full sweep of tens of thousands of boards with its own 24 h directory
  cache. Run it once per machine on the union of the people's filters, not once per person.
- The `--verify` step of `scan.mjs` and `check-liveness.mjs`, which check each *new* posting
  (dozens a day, not thousands).
- Any provider that calls `fetch` itself or drives a browser.

So `ONLY=1` is a guarantee about the boards, not about the whole process. If readers must
never reach the job sites at all, block that egress for them in the network policy as well,
and give the fetcher the only route.

## The `no-store` decision

A server that sends `no-store` is asking caches not to keep the response. Workday does it
on its public job-list endpoint (`no-store, no-cache`, no ETag, measured on NVIDIA and Santander);
the unmodified cache honors it, so those boards are re-read for every person. The other hosts that
still made requests with a hot store (Oracle Cloud, Eightfold, BMW) probably do the same, which was
not checked. Keeping these responses is what makes the biggest board (NVIDIA, 559 requests) a
once-a-day cost instead of a per-person one. `STORE_NO_STORE=1` is opt-in, for the fetcher only, so
the decision is the operator's: leave it off and those boards stay per-person, each reader making
the same requests from the same address; turn it on and the fetcher holds a public job list for up
to the TTL.

## Size and cleanup

About 270 MB for one scan of ~215 boards (520 files). The same request overwrites the same file,
so the store stays about that size; a request nobody makes any more is pruned after 7 days, on each
fetcher run. Nothing in the store names a person or what a person searched for: a key is a hash of
method, URL and body.

## The postings pool: recycle the full sweep

`scan-ats-full.mjs` reads about 55,000 boards and keeps only what one person's title filter wants, so
its hours serve one person. With `--pool <dir>` (or `CAREER_OPS_POOL_DIR`) it also records every posting
it reads, before any filter, and `pool-derive.mjs` builds any person's list from that record.

```bash
# once per machine, by the fetcher
CAREER_OPS_POOL_DIR=/shared/pool node scan-ats-full.mjs --since 3

# per person, no network
CAREER_OPS_POOL_DIR=/shared/pool node pool-derive.mjs --summary
```

The pool is an append-only TSV (`postings.tsv`): a posting is written once, the first time its key is
seen, with that day as `first_seen`. Later sweeps add only what is new, so a day's growth is small after
the first one. That also gives undated postings (iCIMS, BambooHR, some Workday tenants) a date of our
own; a sweep on its own drops them (372,488 on 2026-11-05).

What `pool-derive.mjs` considers news: a posting dated inside the window, or an undated one first seen
inside it. It applies the person's title filter (with overrides), location filter, blacklist and scan
history. It does **not** apply `content_filter` or `domain_filter`: the pool keeps no posting body and no
board context, so a person who relies on either gets more candidates than a sweep of their own would.

Measured on a 450-board slice: the sweep wrote 998 postings, and for two ATS that date their listings
(Ashby, Lever) the derived list matched the sweep's own matches exactly, salary included; a person with
an empty history got their list in 0.2 s.

**The first sweep of a board is its baseline.** BambooHR and iCIMS list pages carry no date, and the
sweep only asks for one per posting that passes the filter. In the pool those postings are undated, and
on the first sweep of a board they are marked `baseline` and not reported as news (otherwise one sweep
would report every posting a board has ever listed). From the next sweep, a new undated posting counts
by its `first_seen`. Cost: an undated posting that was already open the first time its board was seen is
reported only to whoever ran the sweep, not to people deriving from the pool.

**Size.** About 250 bytes per posting; the first sweep writes a few hundred thousand rows and each later
one adds only what is new. Nothing is pruned yet, so the file grows; a posting that has closed stays as a
known key so that it is never reported as new again.

### The sweep's DNS pace

The sweep caps resolver lookups at 400 a minute (`CAREER_OPS_DNS_LOOKUPS_PER_MIN`), to protect a home
resolver (a Pi-hole breaks at 1000). iCIMS, BambooHR and Workday give each employer its own host, so most
of the 55,000 boards cost a lookup each, and on 2026-11-05 the sweep took 2 h 37 min. On a 458-board
BambooHR slice, 400 a minute took 67 s and no cap took 16 s (4.2 times faster). Raise it only after
checking that the machine's resolver can take the rate; `0` disables the cap.

## Pairing with the rest

- `select-portals.mjs --regions ... --sectors ... --roles ...` decides what a person's file
  scans. The union of those files is what the fetcher reads.
- A schedule suggestion comes from `data/run-timings.tsv` (written by `scheduled-chain.mjs`).
  With a shared store a person's scan is a few seconds of parsing, so the fetch time is what to
  schedule around: start the fetcher early enough to finish before the first reader.

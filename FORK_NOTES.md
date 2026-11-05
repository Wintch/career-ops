# Fork notes

## Purpose

This fork of career-ops is a general job-search tool for people who do not live in
the markets upstream was built around. Its first user searches from Argentina, so
the work so far centres on Latin America, and the goal is the same for any country:
find the employers that hire where the candidate is, and the ones that hire from
abroad.

What the fork adds on top of upstream:

- **Sources.** Providers and scanners for regional and niche boards (Computrabajo,
  Bumeran and ZonaJobs, Djinni, games and streaming boards, Mercor),
  each one only if it passes the Source Indexing Policy. Boards that do not are
  recorded, with the reason, in `docs/SUPPORTED_JOB_BOARDS.md` ("Evaluated, not supported").
- **Employers.** Example sections in `templates/portals.example.yml` for employers
  that hire a remote candidate from the country (remote-LatAm firms, nearshore
  agencies, remote-first companies) and for local employers.
- **Tooling for a daily check.** `scheduled-chain.mjs`, `prescreen-location.mjs`
  and the field notes in `docs/JOB_SITE_NOTES.md`.

Rule for adding an employer: it has local hiring, or at least one open posting that
names the candidate's country, its region or "worldwide remote". The evidence goes in
the entry's `notes`. A board that only lists US or EU roles is left out, because
every extra board adds to the time of each scan.

What the fork does not do: it never applies for anyone (drafts stop before Submit),
it does not run scheduled scans on its own, and nothing personal lives in git. CV,
profile, `portals.yml`, `data/`, `reports/` and `output/` stay in the gitignored
user layer (see `DATA_CONTRACT.md`).

This file is the fork's own bookkeeping, kept on `local/fork-notes` and never meant
for upstream.

> **State since 2026-11-04:** the topic branches described below were collapsed
> locally; only `integration` and `main` exist in the working copy, and fixes now go
> straight to `integration`. The remote topic branches on the fork are older copies
> and do not carry later fixes. The branch table and the resync recipe describe the
> model they were built under.

## Branch model

One branch per unit of review, based on `origin/main`, each one PR-able on its own.
Geography goes in template sections and docs, never in branch names. A region
branch turned into a catch-all once (`feat/latam-sources`); that is what this
model avoids.

| Prefix | Meaning |
| --- | --- |
| `feat/<x>` | A source, provider or feature that could go upstream |
| `fix/<x>` | A bug fix that could go upstream |
| `docs/<x>` | Documentation that could go upstream |
| `local/<x>` | Fork-only additions, not meant for upstream |

`integration` is `origin/main` plus a `--no-ff` merge of every topic branch. It is
the branch that runs locally and that the Hermes deployment syncs. Never edit it by
hand: change the topic branch, then merge it in again or rebuild `integration`.
The only commits made straight on `integration` are the ones no topic branch can
hold: a fix to a merge resolution, or removing a file that only `integration`
carries. Each one is listed under "Commits made on integration" below.

`fork/main` mirrors `origin/main`; push it at every resync (it lags otherwise).

### Current branches (2026-10-12)

| Branch | Content |
| --- | --- |
| `feat/plata-portal` | Plata (Mexico fintech) in the example tracked companies |
| `feat/computrabajo-provider` | Computrabajo provider, one site per Latin American country |
| `feat/navent-scanner` | `scan-navent.mjs`, Playwright scanner for Bumeran and ZonaJobs |
| `feat/argentina-portals-example` | Argentina job portals in the example config |
| `feat/contacto-public-post` | Public "looking for work" post variant of `contacto` |
| `feat/watch-mode` | `watch` mode, a company watchlist |
| `feat/yc-hn-jobs` | `yc-jobs` and `hackernews-jobs` providers, `--hiring-only` for YC seeds |
| `feat/games-boards` | Games-industry boards (Remote Game Jobs, Work With Indies, Games Jobs Direct) |
| `feat/artstation-provider` | ArtStation Jobs provider, from the public JSON feed (carries remote and relocation flags) |
| `feat/gamesworkshop-provider` | Games Workshop careers provider |
| `feat/scan-title-overrides` | `scan.mjs` applies `title_filter_overrides` to tracked companies |
| `feat/djinni-provider` | Djinni provider (Ukraine IT) |
| `feat/softserve-provider` | SoftServe careers provider |
| `feat/streaming-infra-employers` | Streaming/video and cloud-native employers in the example config |
| `feat/latam-employers` | Latin America tech employers and LatAm VC boards in the example config |
| `fix/workday-bare-locale` | Workday careers URLs with a bare locale (`/es/`, `/pt/`) |
| `docs/hermes` | Running career-ops under Hermes in per-person containers |
| `docs/openqube-latam` | Points `deep` and `oferta` at openqube.io for LatAm employers |
| `docs/ukraine-sources-evaluated` | Ukrainian and Russian boards evaluated and not supported |
| `docs/sources-evaluated-2026-10` | The 2026-10-11 survey's unsupported boards (stacked on `docs/ukraine-sources-evaluated`) |
| `docs/job-site-handling` | Generic notes on how each kind of job site behaves (ATS APIs, Workday, iCIMS, Get on Board, Djinni, LATAM aggregators) and the working concepts of the funnel |
| `feat/djinni-liveness` | `check-liveness.mjs` rung for Djinni: reads the posting page (JobPosting + validThrough, or the 'no longer active' notice) so Djinni leads stop coming back `uncertain` (based on `090f787e`; rebase at the next resync) |
| `feat/hibob-provider` | HiBob career-site ATS adapter (`<tenant>.careers.hibob.com/api/job-ad` with the public `companyIdentifier` header; whole board in one call). Measured on five tenants, one an Argentine fintech with 18 postings (based on `090f787e`) |
| `local/fork-notes` | This file |

Rebased cleanly onto current `origin/main` on 2026-10-23 (see "Watching upstream" log):
`feat/plata-portal` (`587a57df`), `feat/argentina-portals-example` (`7f69fa4b`),
`feat/contacto-public-post` (`a8852b9a`), `feat/games-boards` (`49e93c29` — its three
providers, Remote Game Jobs/Work With Indies/Games Jobs Direct, no longer exist
upstream at all, so the rebase replayed clean with nothing to conflict against). Not
merged into `integration`; that still runs the pre-rebase content via the 2026-10-11/12
reorg history. All other topic branches below are still on their original (stale) base.

Retired on 2026-10-11 and deleted from the fork, kept only as local branches:
`feat/latam-sources` (the pre-split catch-all), `personalized`,
`fix/gitignore-agent-inbox` (upstream already ignores `data/agent-inbox.md`). The
local-only `backup/pre-reorg-2026-10-11` holds the state before the split.

Dropped on 2026-10-12 after the code review, deleted from the fork and kept only as
local branches: `feat/alternativateatral-provider` (its listing names no employer,
so it fails rule 1) and `local/art-boards-scan` (it read two boards that refuse the
declared client through a browser User-Agent, with no `robots.txt` check). The
local `integration-pre-rebuild-20261012` holds `integration` as it was before.
What `local/art-boards-scan` read is now covered without a browser User-Agent: ArtStation and
Games Workshop have their own providers, the publishers use `title_filter_overrides` on tracked
companies, and the games boards were already providers. A copy of the scanner, with
`notify-new.py`, came back straight onto `integration` on 2026-10-23 (`4ac95763`) and was
removed again on 2026-11-02 (`623d7613`), once nothing was calling either file.

### Resyncing with upstream

1. `git fetch origin`.
2. Rebase each topic branch onto `origin/main` in a separate worktree, so the main
   checkout and its ignored data stay where they are.
3. Rebuild `integration` from `origin/main` with a `--no-ff` merge per topic, in
   the order of the table above (`docs/sources-evaluated-2026-10` after
   `docs/ukraine-sources-evaluated`). Several branches add stanzas at the same spot
   in `templates/portals.example.yml` and rows in `docs/SUPPORTED_JOB_BOARDS.md`;
   those conflicts resolve by keeping both sides.
4. Run the full `node test-all.mjs` on `integration`.
5. Stage files by name and check that nothing personal is staged before any push.
6. Push the topic branches, `fork/main`, and `integration` with
   `--force-with-lease` (a rebuild rewrites it).

## Watching upstream

Check upstream (career-ops-hq) at least weekly; it moves fast (81 commits on `main` in the day before the first check).

```bash
git fetch origin --tags
git log --format='%h %ad %s' --date=short integration..origin/main | head -40    # what is new
git merge-tree --write-tree --name-only integration origin/main | tail -15       # would a merge conflict?
node update-system.mjs check                                                      # published release only
git show origin/release-please--branches--main:CHANGELOG.md | head -40            # next release notes
```

Resync only when a release lands or a fix is wanted: follow the rebuild steps above (rebase topics in a separate worktree, rebuild `integration`, `node test-all.mjs`, confirm before any push).

| Checked | Upstream main | Release | Notes |
| --- | --- | --- | --- |
| 2026-10-22 | merged into `integration` | v1.37.0 | Merged clean (kept both sides on a few doc/test conflicts). `scan-navent.mjs` now reads YAML via `lib/yaml-document.mjs` (upstream #5464) — carry that into `feat/navent-scanner` on its next rebase. |
| 2026-10-23 | v1.38.0 applied via `update-system.mjs apply --confirm` | v1.38.0 | **Kept the fork's `providers/computrabajo.mjs`** — upstream's rewrite is incompatible with the real `portals.yml` entry's `searchKeywords`/`max_pages` shape; swapping it would silently break that board. `scan-ats-full.mjs` merged (upstream's timeout fix + fork-only `--hiring-only`). All tests green. |
| 2026-10-23 | — | — | Tried the full topic-branch rebuild; most `feat/*`/`fix/*` branches aren't cleanly based on `origin/main` (they were cut from old `integration` merge history), so an ordinary rebase replays dozens of unrelated commits. Only 4 branches rebased clean (noted in the branch table above). **`integration` was not rebuilt** — still at the v1.38.0 commit above. Next attempt: check branch ancestry first; anything that fails needs its unique commits extracted onto a fresh base before rebasing is useful. |
| 2026-11-01 | `6825dc60` (164 ahead of the 2026-10-27 sync base `82d20c85`), merged into `integration` as `2afaf0ea` | still v1.38.0 | Merged after the 2026-11-01 docs/portals branches. Four both-sides conflicts, all kept both: `docs/SUPPORTED_JOB_BOARDS.md` (Bumeran/ZonaJobs + upstream's Bulldogjob), `templates/portals.example.yml` (hibob + upstream's deel stanzas; upstream's own LatAm employer section + `feat/latam-employers`), `liveness-api.mjs` (our `djinni` entry + upstream's `ultipro`, as two separate objects), `tests/providers/url-encoding-surrogate.test.mjs` (sorted union). Upstream's new plugin directories copy `.agents/skills/career-ops/SKILL.md` and test it byte for byte, so the fork's `watch` router line needed `572a6254` on `integration`. **Carry `572a6254` into `feat/watch-mode` when it is next rebased.** Full suite: 19833 passed, 0 failed. Worth using: `deel` provider (jobs.deel.com tenants), scan years-of-experience filter read from the JD (#6154), `keyword-match` against a posting URL (#6191), oferta role-clarity check (#6095), invite-match pre-interview email (#6100), batch `--mode match` (#5404), privacy guard for the non-Claude LLM runners (#5571). |

## Known-fixed boards (2026-10-23)

Found by a full `verify-portals.mjs` sweep; all confirmed live after the fix, 0 unresolved across 290 entries.

- `Computrabajo — Argentina`: provider caps at 8 `searchKeywords`, entry had 13 → threw every run. Split into two entries.
- `Templafy`: Greenhouse → Teamtailor (`templafy.teamtailor.com`).
- `Runway`: Greenhouse → Ashby, also domain change (`runwayml.com` → `runway.com`) → `jobs.ashbyhq.com/runway-ml`.
- `Hightouch`: Greenhouse → Ashby (`jobs.ashbyhq.com/hightouch`).
- `Wayve`: Greenhouse → Ashby (`jobs.ashbyhq.com/wayve`).
- `Sanctuary AI`: Lever → Kula.ai (`careers.kula.ai/sanctuary-ai`); no Kula provider yet, left on `scan_method: websearch`.
- `Ada`: stale Greenhouse slug `ada` → `ada18`.
- `Lindy`: never on Ashby (misleading 200 from the SPA shell on any path); real board is Teamtailor (`careers.lindy.ai`).
- `Clarity AI`: Greenhouse board dead (404 on every domain, broken on their own site too), no replacement ATS found — disabled.
- `Agentic Engineering Jobs`: their own API 500s on every request — disabled, recheck later.

## Source backlog

From a survey of about 160 sources on 2026-10-11. Every probe used the scanner's
own client and User-Agent from an Argentine network. Boards that failed the Source
Indexing Policy are recorded in `docs/SUPPORTED_JOB_BOARDS.md` under "Evaluated, not
supported".

### Considered and not built (2026-10-20)

- **Upwork, Fiverr:** freelancers pay to apply (Upwork Connects), Upwork's job search needs an approved OAuth app, and no official Fiverr buyer-request API was found. They fail rule 1 of the Source Indexing Policy or need a third-party account, so they stay manual (see `docs/JOB_SITE_NOTES.md`).
- **Darwinbox (2026-10-20):** the careers app is a JS shell; its job-list calls (`POST /ms/candidateapi/job/alljobs`) answer a Cloudflare WAF 403 to the scanner's client on every real tenant measured, so a provider would need browser-minted cookies or tokens. Ruled out by the provider guide; revisit only if a no-auth path appears.
- **Workana:** answers the scanner with a Cloudflare 403 (probed 2026-10-11, see `docs/SUPPORTED_JOB_BOARDS.md`); terms not reviewed. **Reddit job subreddits and modding forums:** not built; their posts are requests from individuals rather than identifiable employers (rule 1), and their terms and robots were not checked.

### Considered and not built (2026-11-01)

A no-account sweep of remote and regional platforms; the reasons are in `docs/SUPPORTED_JOB_BOARDS.md` ("Evaluated, not supported", rows dated 2026-11-01) and the handling notes in `docs/JOB_SITE_NOTES.md`.

- **Remote Rocketship:** aggregator, so not a provider. It is the best *employer-discovery* feed found so far: its server-rendered `__NEXT_DATA__` carries each posting's employer ATS URL, which is how the 61 remote-LatAm employers in `templates/portals.example.yml` were found (branch `feat/latam-employers`). Re-run that discovery by hand every few weeks; `robots.txt` disallows `/api`.
- **DailyRemote, JustRemote, Remote.co, GameJobs.co, InGameJob:** aggregators (rule 5); DailyRemote also hides the employer.
- **Hitmarker:** client-rendered listing (browser only).
- **Habr Career:** readable (RSS/JSON) but useless outside Russia; build only if a Russia-based user asks.
- **Telegram job channels/bots:** documented only; the `telegram-channel` provider stays opt-in.
- **Deel job boards** (`jobs.deel.com/<slug>`): upstream shipped a `deel` provider in this sync (#6189). Many remote-LatAm employers post there; worth a discovery pass to add tenants. Discovery pass done 2026-11-01: Deel has no tenant directory, but a WebSearch restricted to `jobs.deel.com` (with infra keywords) surfaces about 25 tenants. Only one had an infra role open to LatAm (IT Tech Hub, a staffing firm whose board slug is a UUID); it went into the `feat/latam-employers` example section. Slugs are case-sensitive (`Range` works, `range` does not).

### Built and considered (2026-11-02)

- **Mercor** (`feat/mercor-provider`, provider `mercor`): `work.mercor.com/explore` server-renders the whole public inventory (about 316 contracts) in one `__NEXT_DATA__` blob, with eligible countries, pay and dates; `robots.txt` allows it. It ships disabled in the example config. For upstream it still needs a `docs/SOURCE_INDEXING_LOG.md` entry and probably a source proposal: it is a talent marketplace, and applying needs a Mercor account.
- **AI-training and contract platforms**, probed 2026-11-02 with a plain client after reading `robots.txt`:
  - Invisible Technologies (Greenhouse board `agency`, about 830 postings, some marked Argentina or LATAM/worldwide remote), Turing (Greenhouse `turing`) and Toloka (Greenhouse `toloka`) need no code; they are ordinary `tracked_companies` entries.
  - Alignerr exposes only the first 60 of about 5,600 listings.
  - DataAnnotation and Mindrift publish evergreen category pages, with nothing to diff.
  - Handshake AI's contractor reqs are US PhD roles.
  - Appen, Welocalize and HumanSignal have no technical roles for this region.
  - Braintrust and Contra are client-rendered; Toptal and Gun.io sit behind Cloudflare; A.Team returns 404.
  - micro1, Outlier, Revelo and Snorkel have no public listings.
  - web3.career has JSON-LD on every page, but its "Anywhere" location tag is boilerplate.
- **Remote Rocketship** is still not a provider, for the reason above. Reading page 1 of a few `/country/<c>/jobs/<title>/` pages is within `robots.txt`, and the research pass rated it the next thing worth building. It would be an aggregator provider that emits employer ATS URLs, so it needs a source proposal first.
- **`scheduled-chain.mjs`** (`feat/scheduled-chain`): one command for an external scheduler. Asked for by the bridgeai deployment, which schedules the scans at off-peak hours.

### Commits made on integration

| Commit | What | Where it went |
| --- | --- | --- |
| `4ac95763` | `art-boards-scan.mjs` and `notify-new.py` | Removed in `623d7613` |
| `760e8779`, `08eeb474` | EntertainmentCareers.net provider and its manifest entry | Moved to `feat/entertainmentcareers-provider` (2026-11-02) |
| `23afd799` | `docs/applicant-privacy/disney.md` | Moved to `docs/applicant-privacy` (2026-11-02) |
| `572a6254` | Plugin-directory SKILL.md copies synced with the router | Carry into `feat/watch-mode` when it is offered upstream |
| `623d7613` | Removal of the two scripts above | Stays: no topic branch can hold a removal of an integration-only file |
| `8cf5fbfd` | Cherry-pick of the ArtStation unsupported-row fix from `feat/games-boards` | That branch never merges into `integration` (its content landed another way, and it conflicts in the example config), so only the fix was carried over |

### Fork review (2026-11-02)

A four-axis review of everything the fork adds (code, privacy, upstream overlap, docs), with every finding re-checked by a second reviewer. The fixes went to the owning topic branches. Fixed:

- EntertainmentCareers throws when every keyword fails and drops cards with no employer.
- `scan-navent.mjs` honours `data/blacklist.md`.
- `scan.mjs` hands `title_filter_overrides` to Workday's placeholder pre-filter.
- The duplicate Chainguard example is gone.
- `docs/JOB_SITE_NOTES.md` is generic again, with no account history.
- The ArtStation, Bulldogjob and YC rows agree with their providers.
- The Disney consent note no longer points at one application.
- The watch mode's cross-reference is accurate.

Still open:

- **Branches whose content is already in `integration`:** `feat/argentina-portals-example`, `feat/plata-portal`, `feat/contacto-public-post` and `feat/games-boards`. Keep them as PR sources; they merge cleanly into `origin/main`.
- **Branches to drop:**
  - `fix/gitignore-agent-inbox`: upstream already ignores the file.
  - `personalized` and `feat/latam-sources`: superseded catch-alls.
  - `local/art-boards-scan`: superseded.
  - `feat/alternativateatral-provider`: fails rule 1.
- **Backups:** `backup-pre-rebuild-20261023`, `backup-pre-update-1.37.0-*` and `integration-pre-sync-*` are ancestors of `integration`, so they can be pruned. `integration-pre-rebuild-20261012` and `backup/pre-reorg-2026-10-11` hold commits found nowhere else.
- **Closest to an upstream PR:**
  - `feat/mercor-provider`, after a `SOURCE_INDEXING_LOG` entry.
  - `feat/games-boards`, `feat/plata-portal`, `feat/argentina-portals-example` and the `docs/*` branches.
  - `fix/workday-bare-locale`, after a rebase.
- **Need a rebase first:** the rest have mechanical conflicts, or carry dozens of unrelated commits that call for a cherry-pick.
- **Board-type providers missing a `docs/SOURCE_INDEXING_LOG.md` entry:** djinni, gamesjobsdirect, remotegamejobs, workwithindies, artstation, hackernews-jobs, entertainmentcareers, mercor and computrabajo. Upstream keeps one for every listed source, and each provider needs one before it is offered upstream.
- **`computrabajo`** replaces upstream's provider under the same id, with a different config shape (`searchKeywords`). Upstream's `SOURCE_INDEXING_LOG` entry and its Computrabajo Colombia example describe the old shape. Settle this before offering it.
- **Old commits on the public fork branches** still contain the deployment notes that were removed from `docs/HERMES.md`, and every commit carries the author's e-mail. Removing either means rewriting public history, which is the owner's call.

### To build, in priority order

| Source | Region | Access path measured | Effort | Notes |
| --- | --- | --- | --- | --- |
| SwissDevJobs + GermanTechJobs | CH / DE | `/api/jobsLight` on both hosts (whole inventory in one call) | S | Keep GermanTechJobs to `isPartner:false`: 810 of 901 are partner backfill. Whether that is enough under rule 5 is a maintainer question |
| Prospective career-center | Switzerland | `ohws.prospective.ch/public/v1/medium/1000624/jobs` | S | Behind jobs.admin.ch; the same vendor also serves Swisscom, SRG and others |
| jobs.ch + jobup.ch (JobCloud) | Switzerland | `/en/vacancies/?term=&page=N` (JSON-LD list) | S-M | One provider, two hosts |
| CV.ee / CV.lv / CVonline.lt | Baltics | `/api/v1/vacancy-search-service/search` | S | One provider, three hosts; sort by date because of promoted listings |
| Remotar | Brazil, remote | `api.remotar.com.br/jobs?page=N&search=` | S-M | 11,135 jobs, links to the employer's ATS; confirm it is not an aggregator under rule 5 |
| Japan Dev | Japan | `/jobs?page=N` (HTML; detail pages have JSON-LD) | M | Flags "Residents Only" and "Japanese Required" |
| Finn.no | Norway | `/job/search?q=` (embedded JSON) | M | Paid placements change the order, so read every page |
| NAV arbeidsplassen | Norway | `/stillinger?q=&v=6` (HTML) | S-M | Many listings are re-published from Finn |

Next:

- Europe: karriere.at, ITJobs.pt (1 s crawl delay), dev.bg, Berlin Startup
  Jobs (RSS), Infostud, kariyer.net, staff.am, jobs.ge (5 s crawl delay),
  BestJobs.eu, MojPosao.hr.
- Public services: UN Careers (`careers.un.org` JSON), NHS Jobs, CBOP Poland (keyword
  filter format still unknown), service.bund.de RSS (30 s crawl delay), HZZ Croatia
  RSS, Argentina Portal Empleo (tiny).
- Latin America: GeekHunter, Hireline, Chiletrabajos, Programathor, Vagas.com.br, and
  five more Navent sites (Laborum, Konzerta,
  Multitrabajos, Bumeran PE and MX) to add to `scan-navent.mjs` `SITES`, which has
  only Bumeran and ZonaJobs today; their search API is not yet tested.
- Niche: Golangprojects (RSS), GitJobs (CNCF, 19 jobs).
- New ATS adapters: HiBob done (`feat/hibob-provider`); Darwinbox blocked (see "Considered and not built").

### Waiting on a maintainer decision

These pass the technical checks but raise a policy question, so they belong in an
upstream issue before any code.

- **robota.ua**: `api.rabota.ua` is open, but the site's own `robots.txt` sits behind
  a challenge and cannot be read.
- **EURES**: a clean API, but it re-publishes national employment services (rule 5)
  and many postings have no employer.
- **relocate.me**: applying needs a free account, and a paid partner listing is in the
  feed.
- **NAV feed API**: needs the token NAV publishes openly.
- **HelloWorld.rs**: its footer forbids reusing content without permission.
- **Reed**: mostly agency listings with the employer hidden.
- **Elempleo**: about half the listings are "Empresa confidencial".
- **Strider**: attribution not confirmed.
- **DevOpsJobs.io**: applying goes through a registration page, and no employer URL is
  given.
- **Impactpool**: curated aggregator with a paid premium tier.
- **Latvia NVA open data**: the employer appears only as a registration number.
- **IamExpat, StartupJobs.cz**: the employer appears only on detail pages.
- **ProductionBase, StaffMeUp**: subscription or weak attribution.

Stopped by this fork's own rules, recorded in "Evaluated, not supported": Catho and
Trabajando (paid candidate tiers), BroadcastJobs.com and Youthall (`robots.txt`
names Claude's crawler), EPAM (`robots.txt` disallows the paths a provider needs).

### Needs an API key

USAJOBS, France Travail, ReliefWeb, Job Market Finland, Korea Work24, Japan Hello
Work, InfoJobs Spain. Each is also recorded in "Evaluated, not supported".

### Re-measure from another network

These timed out or failed TLS from Argentina, which says nothing about the source:
Hipo.ro, Profession.hu, Naukrigulf, Workforce Australia, TVJobs, SMPTE careers, Spain
Empléate, Peru, New Zealand jobs.govt.nz, Slovenia ESS, Brazil Emprega Brasil,
Colombia SPE, Uruguay Vía Trabajo.

Not finished: JobsIreland (search endpoint not found), Chile BNE (its JSON endpoint
answered 500), Estonia Töötukassa, Coodesh, Next Level Jobs, CV Market LT,
EuropeLanguageJobs.

### Employers not covered by a supported ATS

Globant (custom site), EPAM (`robots.txt`), BairesDev (Cloudflare
challenge, even on `robots.txt`), Akamai (careers link not found), Synamedia
(Darwinbox), and Brightcove, Vimeo, Wowza, Haivision, Daily, Agora, Vidyard, Evertz,
Ross, Telestream and Globo (no supported ATS link found).

### Disclosures

- EPAM got two requests (`/api/jobs/v2/search/careers` and `/en/jobs?query=…`) before
  its `robots.txt` was read; that file disallows both. Nothing more was sent.
- UK Find a job got one request with a browser User-Agent, only to show that its 503
  depends on the User-Agent. No content was read with it.

# Fork notes

This fork of career-ops aims to be a general job-search tool: more countries, more
boards, and non-tech boards (games). Nothing personal lives in git: CV,
profile, `portals.yml`, `data/`, `reports/` and `output/` stay in the gitignored user
layer (see `DATA_CONTRACT.md`).

This file is the fork's own bookkeeping, kept on `local/fork-notes` and never meant
for upstream.

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
| `local/fork-notes` | This file |

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
companies, and the games boards were already providers.

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

## Source backlog

From a survey of about 160 sources on 2026-10-11. Every probe used the scanner's
own client and User-Agent from an Argentine network. Boards that failed the Source
Indexing Policy are recorded in `docs/SUPPORTED_JOB_BOARDS.md` under "Evaluated, not
supported".

### To build, in priority order

| Source | Region | Access path measured | Effort | Notes |
| --- | --- | --- | --- | --- |
| JobTech / Platsbanken | Sweden | `jobsearch.api.jobtechdev.se/search` (JSON, no key) | S | Employer name and the employer's apply URL; 78 "devops" hits |
| SwissDevJobs + GermanTechJobs | CH / DE | `/api/jobsLight` on both hosts (whole inventory in one call) | S | Keep GermanTechJobs to `isPartner:false`: 810 of 901 are partner backfill. Whether that is enough under rule 5 is a maintainer question |
| Prospective career-center | Switzerland | `ohws.prospective.ch/public/v1/medium/1000624/jobs` | S | Behind jobs.admin.ch; the same vendor also serves Swisscom, SRG and others |
| jobs.ch + jobup.ch (JobCloud) | Switzerland | `/en/vacancies/?term=&page=N` (JSON-LD list) | S-M | One provider, two hosts |
| CV.ee / CV.lv / CVonline.lt | Baltics | `/api/v1/vacancy-search-service/search` | S | One provider, three hosts; sort by date because of promoted listings |
| Remotar | Brazil, remote | `api.remotar.com.br/jobs?page=N&search=` | S-M | 11,135 jobs, links to the employer's ATS; confirm it is not an aggregator under rule 5 |
| Japan Dev | Japan | `/jobs?page=N` (HTML; detail pages have JSON-LD) | M | Flags "Residents Only" and "Japanese Required" |
| Finn.no | Norway | `/job/search?q=` (embedded JSON) | M | Paid placements change the order, so read every page |
| NAV arbeidsplassen | Norway | `/stillinger?q=&v=6` (HTML) | S-M | Many listings are re-published from Finn |

Next:

- Europe: karriere.at, jobs.cz, ITJobs.pt (1 s crawl delay), dev.bg, Berlin Startup
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
- New ATS adapters: HiBob (used by Ualá), Darwinbox (used by Synamedia).

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

Globant (custom site), Ualá (HiBob), EPAM (`robots.txt`), BairesDev (Cloudflare
challenge, even on `robots.txt`), Akamai (careers link not found), Synamedia
(Darwinbox), and Brightcove, Vimeo, Wowza, Haivision, Daily, Agora, Vidyard, Evertz,
Ross, Telestream and Globo (no supported ATS link found).

### Disclosures

- EPAM got two requests (`/api/jobs/v2/search/careers` and `/en/jobs?query=…`) before
  its `robots.txt` was read; that file disallows both. Nothing more was sent.
- UK Find a job got one request with a browser User-Agent, only to show that its 503
  depends on the User-Agent. No content was read with it.

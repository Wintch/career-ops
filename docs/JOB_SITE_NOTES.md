# Job site handling notes

Field notes on how each kind of job site behaves when career-ops reads it or when a candidate applies through it, plus the working concepts that came out of a real search. Everything here is generic: no candidate data, and no claim that a behavior is permanent. Sites change, so each note says how it was observed and what to re-check.

Companion docs: `docs/SUPPORTED_JOB_BOARDS.md` (what the scanner can read), `providers/ADDING_A_PROVIDER.md` (how to add a source), `docs/KEEPING_PORTALS_LIVE.md` (keeping `portals.yml` healthy).

## 1. Working concepts

**The funnel.** Discover boards, scan, pre-filter, triage, evaluate, draft, human submits. Each stage is cheaper than the next, so spend tokens only on what survived the previous one.

- **Zero-token pre-filter first.** A backlog of thousands of scanned URLs is mostly roles in the wrong country. Filter the pipeline by location (remote, worldwide, the candidate's country or region) and by role keywords, then drop what the tracker already knows. A few dozen survive.
- **Triage before a full evaluation.** `triage` reads only the compact brief, writes no files and returns GO / MAYBE / SKIP. Promote only GO and the best MAYBEs.
- **Liveness is a three-way answer.** `active`, `expired` and `uncertain`. `uncertain` means the page rendered content but no apply control was visible (login walls, client-rendered pages). It is not closed. Open the posting by hand before applying.
- **A scanned board is not an opening.** Aggregators and "spontaneous application" postings stay live for years. Confirm the role at the employer (see AGENTS.md, Aggregator Listings), and treat an evergreen req as a low-probability application, not as a vacancy.
- **Honest gap handling.** When a recruiter asks "have you worked with all of these?", answer with what was used in production and list what was not, by name. It costs little and filters out interviews that would not close. Never move a skill into the CV because a posting asks for it.
- **Interests are a targeting input, not a CV claim.** Priorities such as remote-first, interesting projects, games/modding or media go into the profile and the triage brief (user layer), where they raise fit scores. The same facts reach application content only if `cv.md` supports them.
- **Skill-gap list.** `node upskill.mjs` aggregates the gaps across reports. Turn the top of that list into a learning plan with a practice project per skill, and add a skill to the CV only after real use.
- **Parallel agents.** Reserve report numbers first (`reserve-report-num.mjs`). Give every worker its own temp files: a shared scratch file such as `jd.txt` gets overwritten by a sibling. After the workers finish, check that each report's archived JD belongs to its own posting, then run `merge-tracker.mjs` once.
- **Learn the person first, then search.** Read everything the candidate has already published about themselves (CV, personal site, public repositories) and ask a few direct questions: what to avoid, what is exciting, what pay is acceptable for an exciting project, what a "fallback" role is. Write the answers into the user-layer profile and triage brief (`modes/_profile.md`, `modes/_brief.md`), where they steer scoring, not into the CV. Re-ask when a concrete case shows a rule is missing (for example how much less is acceptable for an interesting project).
- **Pay is not the only price.** A role where one person carries the whole stack carries responsibility a salary band does not describe; price it above the general floor and say so in the evaluation. An acceptable but unexciting role can be tagged "fallback": apply to gain experience while the search continues.
- **Leads from a web search decay fast.** In one pass, two of five leads were already 404 and two more showed no apply control. Run `check-liveness.mjs` on every lead and confirm at the employer's own board before evaluating anything.
- **Noisy boards need a country filter or stay off.** A "remote" startup board whose listings are mostly restricted to the US or the EU fills the pipeline with roles the candidate cannot take. Dry-run a new board (`node scan.mjs --company "<name>" --dry-run`) and keep it only if the eligible share is worth the review time.
- **Prefer APIs and the scanner's HTTP client** over driving a person's logged-in browser. Automating the candidate's own browser session can disturb work in progress. When a site refuses automated reads, say so and ask for the pasted text.
- **Pre-filter gaps to read by hand (observed 2026-11).** A location pre-filter that keeps "remote" postings lets through restrictions written in unusual shapes: "Remote - Greece", "Work from Home, Bulgaria", "IND-Work from Home-Remote", "Remote Arizona", a US-state list, or only a URL slug such as `.../job/Remote/...-Remote-US_...` while the location field says just "Remote". After the dry run, read the survivors' location and URL before triage and discard those by hand with a reason (and a line in `data/discard.log`). A short allow-list of the candidate's own region plus "worldwide"/"anywhere" is safer than a long deny-list.
- **Tracing where a posting came from.** When an evaluation needs to know "how did this reach me?" (for example the agency gate), look the URL up in `data/scan-history.tsv`: the `portal` column names the provider (`himalayas-api`, `getonbrd-api`, ...), `first_seen` the day the scanner saw it and `posted_at` the board's own date. A posting the scanner found is not one a recruiter sent; the intermediary is whoever the posting names ("posted by X on behalf of Y"), not the portal. Say that plainly when asking the candidate to confirm the agency.
- **Republished requisitions.** The same role comes back under a new id after the old one closed (one Djinni requirement reappeared three times within two months). Before spending an evaluation, search the tracker by company and title; if the text is unchanged, link the new posting to the old row in the notes instead of treating it as a new opening. `precheck-duplicate.mjs` can miss it when the old row is already Discarded and the id differs.
- **Hourly contract pay needs hours to mean anything.** Convert it into a monthly figure at a stated hours-per-week range before comparing it with a monthly floor (floor ÷ weekly hours ÷ 4.33 = the hourly rate needed). A listing that gives a rate band but no hours, duration or client cannot be compared, and a band several times wider than its lower bound says little about the rate actually paid.
- **Never submit.** Drafts, answers and PDFs are prepared; the candidate presses Submit.

## 2. Site-by-site handling

### Public ATS APIs (Greenhouse, Ashby, Lever)

- `check-liveness.mjs` answers from the public API and needs no browser; `fetch-jd.mjs` returns the JD text.
- Greenhouse boards often carry a "Spontaneous Application" or "General Application" posting. It is evergreen, not an open requisition: evaluate it as a long shot, and look for a real open role on the same board first.
- An old posting date on a Greenhouse job is the first publication date, not proof of staleness; check `updated_at` and whether the board is maintained.

### Workday (multi-step candidate forms)

- Posting pages are client-rendered; use the API-first liveness path.
- **Observed on one large tenant (2026-10):** on the "My Experience" step, "Save and Continue" kept only the entries added or edited during the current visit to that step. Entries merely displayed from an earlier save were dropped. Autofill-from-resume entries count as new.
- **Workaround:** in one visit to the step, touch every entry (retype a date, for example), save once, then verify the list on the final Review page before submitting. Not confirmed by the vendor; re-check on the next application.
- Some employers state in a public hiring FAQ that applications may be screened by AI and allow an opt-out. Read the FAQ before the "Application Questions" step and decide consciously.

### iCIMS

- Multi-step: contact data, work-authorization questions, a confidentiality/NDA acknowledgement, optional cover-letter upload, final review.
- The "County" address field generally means province or state outside the US. Use the real administrative division, not the city's metropolitan name.
- Read the employer's privacy policy link on step 1 and note what data it retains.
- **Reading the posting (2026-11):** many iCIMS career sites embed the job in an iframe (`...?in_iframe=1`) inside the employer's own site. `node browser-extract.mjs <url>` then returns only the surrounding site chrome (`empty_text`) and a bare HTTP fetch gets nothing, so the posting looks unreadable even though it is live. Headless Playwright reads it from the child frame (`page.frames()`, the one with the long body text); no login and no visible window are needed. If that is not available, paste the posting text.

### Get on Board (LATAM-focused board)

- A public JSON API lists jobs by category (`/api/v0/categories/{category}/jobs`), including remote modality, eligible countries, published date and often salary. It is the reliable source for liveness and JD text; the HTML page is not needed.
- The application form blocks pasting text copied from outside the site (only copy/paste inside the same site worked). Prepare compact answers that can be typed by hand, and keep them short.
- A candidate account is required. Its privacy policy states that deleting the account removes the applications; read it before applying.
- Staffing/consultancy postings are often evergreen (hundreds of applications over months). Salary is frequently absent.

- Some postings are published by a staffing company "on behalf of" a named client. That triggers the agency gate (ask the candidate which channel it came through) and the end employer, when named, goes in the tracker's company column with the staffing company as Via.
- `fetch-jd.mjs` can exit 1 with empty output for a Get on Board posting (the API route it uses does not always answer); `browser-extract.mjs` reads the same page. Use one attempt of each and then stop (observed 2026-11).

### Djinni (Eastern-Europe-centered board)

- Job pages are readable without login; applying requires a profile. Profiles go through moderation before they are public, which can delay applying by a day or more.
- The apply form has a free-text message plus a recruiter question; answer the question explicitly (see "Honest gap handling").
- Location tags such as "Remote (Europe)" or "Remote (UA)" restrict where candidates may live. "Worldwide" listings can still carry a language field such as "Ukrainian: Native", which in practice is a hard filter.
- The "average salary of similar jobs" figure is the site's analytics, not an offer from the employer.
- `check-liveness.mjs` reads the posting page itself (a `djinni` rung in `liveness-api.mjs`): an open ad embeds one schema.org `JobPosting` with its id and a `validThrough` date, a closed one shows "The job ad is no longer active" and has none. Both are decided without a browser; only an unrecognizable page (a challenge, another id) falls back to `uncertain`.

- An outstaff/outsourcing company can list a role as "Worldwide" on Djinni while its own careers site shows the same text restricted to a region (for example "Ukraine/Europe", with local payroll schemes such as sole-proprietor support). Open the employer's site before treating Djinni's location tag as the eligibility answer, and re-check the requisition id: the same role was republished under new ids several times.

### Bumeran, ZonaJobs and Computrabajo (Argentina and LATAM)

- **Bumeran and ZonaJobs** are client-rendered and empty to plain fetches and to `WebFetch`. Use a dedicated light-touch scanner for listings where one exists (it should read `robots.txt`, pace requests and stop on a challenge), and ask the candidate to paste the posting text when a detail page is needed.
- **Computrabajo** is different: its listing pages are server-rendered over plain HTTPS (about 20 cards per page, no login, no JS), and `providers/computrabajo.mjs` reads them from a `job_boards:` entry, one per country, with search keywords. A card carries employer, location, a relative posted date and sometimes salary and modality, but no employer URL; applying needs a free candidate account.
- Many postings hide the employer behind a recruiting agency. Treat an unidentifiable employer as a legitimacy signal (Block G), never guess it.
- Salaries are usually in local currency and may fall far below a USD floor; ask for range and currency before investing effort.

- Bumeran and ZonaJobs serve one shared inventory (identical result counts per keyword), so searching both only burns the scanner's per-run navigation cap. Search Bumeran only.
- Small and mid-size Argentine employers often title the one-person infrastructure role "Responsable de Sistemas", "Jefe de Sistemas", "Administrador de Servidores" or "Analista de Infraestructura" instead of DevOps or SRE. Add those titles to `title_filter.positive` and expect a hybrid on-site schedule and a salary in local currency.

### Freelance marketplaces (Upwork, Fiverr and similar)

- **Not scanned.** Applying on Upwork costs the freelancer "Connects", so it fails the "free for candidates" rule of the Source Indexing Policy. Third-party documentation says Upwork's job-search API needs an approved OAuth app (verify in the vendor's developer portal), and no official Fiverr API for buyer requests was found (absence of evidence, not a confirmed statement from Fiverr). Driving a logged-in marketplace account with a script is the kind of automation these platforms restrict; read each platform's current terms before any experiment.
- **What works instead.** Set saved searches and e-mail alerts inside the candidate's own account, paste the interesting request into career-ops, and triage it against the candidate's floor and profile. Keep profile and gig texts as drafts built from `cv.md` only; the candidate publishes them.
- **Gig fit.** A gig that sells a deliverable the CV can back (a streaming server setup, Linux hardening, a media-tooling script) is easier to price and defend than a general "DevOps" listing.

### Remote aggregators (We Work Remotely, Remotive and similar)

- Often answer 403 to bare HTTP clients. Read them through the provider modules, which use the scanner's HTTP client and respect robots rules; do not retry with browser impersonation.
- Their listings should be confirmed at the employer before applying.

### Expert and AI-training marketplaces (micro1, Mercor and similar)

- **Pattern.** One company publishes dozens of domain-expert contract roles in days (law, finance, engineering, video, ...) as a talent pool for unnamed customers. In one 12-day window the scanner saw about 28 postings from a single such company. Postings are "Contractor", hourly, remote worldwide, with no client, hours per week, duration, deliverables or manager.
- **Evaluate them honestly, not as vacancies.** The role-clarity check (`role-clarity.mjs`) misses most of its six points; Block G reads "Proceed with Caution". Price the hourly band at a realistic hours-per-week range (see "Hourly contract pay needs hours") and say that work is not guaranteed. A title that matches the candidate's craft (for example a video role for someone with a studio) raises fit, not certainty of work.
- **Applying creates an account** on the marketplace's own platform, often with an AI-run first interview. Log the account in `data/accounts-registry.md` before creating it.

### Himalayas (remote jobs board)

- The API provider lists postings reliably, but the posting pages sit behind a Cloudflare challenge: `fetch-jd.mjs` and `browser-extract.mjs` both fail on them (observed 2026-11). Follow "When a site blocks the agent": do not retry, ask the candidate to paste the posting text, and mark the report's verification line as unconfirmed (JD pasted by the candidate).
- Most of a marketplace company's listings here are US-only; the title/location filters remove them. Read the location field of the few that survive.

### Boards for AI startups, games and creative tech

- **AI/agent startups:** the a16z speedrun talent network, Hacker News "Who is hiring" jobs (YC) and the agentic-jobs listing are cheap to scan, but most roles are on-site in the US. Rely on the title and location filters, and expect few eligible hits per run.
- **Games:** Remote Game Jobs and Work With Indies are small RSS feeds with mostly remote roles; Games Jobs Direct is a paced HTML scraper (respect its crawl delay, scan at most daily). Engine roles (Unity, Unreal) usually name the engine in the title, so add those words to `title_filter.positive`. Many listings are design or junior positions; filter by seniority.
- **Staffing firms that sell AI work** (LATAM-based consultancies, outsourced engineering) post many "remote, LATAM only" roles. Eligibility is explicit in the text, so read the residence requirement before anything else.

### Employer-run career sites with long processes

- Some large open-source and platform employers describe a multi-month process (a written application, a psychometric test, several interviews) on their own hiring-process page. Read that page first and check whether it limits how many roles one candidate may apply to in a period; one report of such a limit was not verified against the employer's terms.

### Canonical (Greenhouse)

- Many Canonical postings are standing/evergreen requisitions, not time-bound openings: three independent evaluations (2026-10) found reqs open 7 months to 2.5+ years with no salary published. Don't read posting freshness the normal way for this employer — check `scan-history.tsv`'s `postedAt` and weigh it as a Block G "Proceed with Caution" context note, not an automatic ghost-job flag, since the company is actively hiring elsewhere.
- Canonical's own application form states that **AI-generated answer content disqualifies the application** (observed 2026-10-24). Any written answers for a Canonical application must be hand-written by the candidate, not drafted by this tool and copy-pasted as-is.
- Comp is paid by geographic PPP; US-sourced salary figures (Levels.fyi, Blind) do not transfer to a non-US hire and should not be used to score the Comp block for a candidate based outside the US.

### NVIDIA (Workday)

- 2026-10-24: every `nvidia.wd5.myworkdayjobs.com` posting URL from that day's scan redirected — via WebFetch, via a real headless-browser fetch (`browser-extract.mjs`), and via `check-liveness.mjs`'s browser path — to the generic `nvidia.com/en-us/about-nvidia/careers/` page with no job id preserved in the final URL. All three independent methods failed the same way, which reads as a tenant-wide outage that day, not a bot block or dead links. If this recurs, retry on a different day before concluding the postings are gone.

### LinkedIn

- Follow the LinkedIn guard in AGENTS.md: one bounded attempt, then ask for pasted text. Never treat a loading failure as a closed posting.

### No-account platform sweep (2026-11-01)

Checked with the scanner's HTTP client and headless `browser-extract.mjs` only: no accounts, no logins, robots.txt read first. The targeting was remote infra/DevOps/SRE work that someone in Argentina or LatAm can take.

- **Remote Rocketship** (aggregator): the best discovery feed of the sweep. `www.remoterocketship.com/country/<country>/jobs/<title-slug>/` is server-rendered, and its `__NEXT_DATA__` JSON (`props.pageProps.initialJobOpenings`) carries the 20 newest postings per page: company, title, location, salary, date, a "ghostScore", and the **direct employer ATS URL**. robots.txt disallows `/api` (deeper pages need it), so only the first 20 per page are fair game; the per-country job sitemaps are an allowed route that was not tested. The apex host redirects, so use `www.`. Treat it as a way to find employers: the useful move is adding each employer's ATS board to `tracked_companies`, after which the regular providers cover them. The "Argentina" pages also list multi-country postings, so confirm eligibility in the JD.
- **DailyRemote** (aggregator): its listing pages are readable, but the company is hidden and the JD is replaced by a sign-up wall, so a posting can't be confirmed at the employer. Low value.
- **JustRemote, Remote.co**: almost everything was US-restricted, and Remote.co search snapshots were stale. Skip.
- **Wellfound**: role and location pages and job details are visible without an account. A few startups hire "Remote (Everywhere)" or LatAm, but the remote DevOps feed is mostly India, US and agency posts. Worth an occasional manual pass; not a scanner target.
- **Hitmarker** (games, client-rendered, robots allows `Claude-User`): high volume and fresh, with explicit "Remote (Anywhere)" tags, but of ~380 anywhere/LatAm-tagged jobs only one was a real SRE/DevOps fit. Mostly art, design and community roles. **GameJobs.co** has the most game-studio DevOps titles, but nearly all are restricted to the US, EU or Canada. **InGameJob** had no remote infra roles. All three are manual-only; for this targeting, the per-studio ATS boards they reveal are worth more than the boards themselves.
- **Outsourcers with public listings**: EPAM (`careers.epam.com`) and AgileEngine (`join.agileengine.com`) each had several DevOps/SRE/cloud reqs open to Argentina-based remote work, often duplicated per client. EPAM now has its own provider (`epam`, since the 2026-11-08 change to Source Indexing Policy rule 6, which made `robots.txt` no longer a gate); AgileEngine is still checked by hand.
- **Talent networks with no public reqs**: BairesDev, Andela, Howdy, Lemon.io, Proxify, Index.dev and Crossover have no public listings; you join a pool, which needs an account. The boards for Toptal, Turing and Strider are public but had nothing eligible for an Argentina-based infra profile that day. Silver.dev (Argentine agency, Ashby board) is mostly backend/AI at high salary bands, with occasional infra.
- **AI training/eval platforms** (gig contracts, not employment; all need an account to apply):

  | Platform | Argentina eligibility (official source) | Relevant listings that day |
  | --- | --- | --- |
  | Mercor | Supported payout country | Infra/SRE, Linux and DevOps-pool listings |
  | Outlier | On the eligible-country list (per-project limits possible) | — |
  | micro1 | Accepts worldwide except a published exclusion list | — |
  | Alignerr | No official country list found | Some listings say "US preferred" |
  | DataAnnotation | Third-party sources say only US/CA/UK/IE/NZ/AU; unconfirmed | — |
  | G2i (public Ashby board) | Per-country contracts, Argentina among them | "AI Training" SWE contracts, including an Argentina req |

- **Video/post-production boards**: ProductionHUB is ~90% US on-site crew work, and StaffMeUp is US on-set booking. Twine and Freelancer.com are dominated by low-budget UGC and reel editing. None showed remote colorist or streaming-infrastructure work worth the time.
- **Habr Career** (Russian-language): public RSS and JSON exist (`/vacancies/rss`, `/api/frontend/vacancies`). In a snapshot of 301 remote vacancies (about 85 of them DevOps/SRE/Linux/infra), none explicitly allowed working from abroad. Nearly all assume Russian residency (ruble pay, ИП/самозанятый, Moscow hours), and only 2 had USD/EUR salaries. It's not worth a provider for someone outside Russia; a weekly manual look at the RSS, filtered for "вне РФ / из любой страны / релокац", is enough.

## 3. Not scanned — search these yourself

Sites career-ops cannot read automatically: a terms-of-service block, a bot challenge, a paywall, or the site is itself a meta-aggregator the Source Indexing Policy keeps out. None of these are touched by `scan.mjs`, so without manual coverage they are off the radar entirely. The full global audit (70+ boards evaluated and excluded — including many that matter only to a specific market or sector, e.g. national public-sector boards in Japan, the Netherlands, Kazakhstan) lives in `docs/SUPPORTED_JOB_BOARDS.md` → "Evaluated, not supported", with the exact technical reason and the date checked. This table is the filtered subset most relevant to remote tech/infra, games/AI, video/color-grading and Argentina/LatAm searches:

**This is not a workaround for the scraping ban.** The ToS/`robots.txt` block named in each row applies to *automated bulk reading* — the thing `scan.mjs` would otherwise do across every tracked company at once. A human using the site's own account, search, and alert features one search at a time is the exact manual usage the site offers every visitor; it doesn't touch the automated-access restriction at all. Pasting a result into career-ops afterward is also fine — that's a candidate pasting their own find for triage, same as any other manually-discovered posting, not the agent reading the site.

**Field notes** in the last column record how each site behaves: whether it needs an account or a CV upload, what it keeps, and anything that speeds up a future integration (a public API found later, a board that turns out to have an ATS feed after all). If you create accounts on these sites, keep your own list of them in `data/` (user layer, stays local, never committed) so they can be cleaned up later.

| Site | Why it's not scanned | How to search it by hand |
| --- | --- | --- |
| Indeed | Its terms forbid automated scraping (not manual use). | Set up a saved search + daily email alert inside your own Indeed account. Paste any interesting posting here to triage/evaluate it. **Field note (2026-10-25):** a plain keyword search (no alert needed) surfaces relevant postings, both on a company's own Indeed page and in the general results list; paste them in for evaluation like any manually found posting. A general (non-JD-tailored) profile CV gives passive recruiter visibility, and an English one reaches the most remote roles (see `/career-ops pdf` with no JD for how to generate one); it is optional, search works without it. Each search-results page has a box for creating an email alert for that exact search (the Spanish-language site words it "Descubrí los nuevos empleos... antes que nadie"), worth doing once per core keyword so new postings arrive by email instead of needing a repeat visit. |
| JobYap | Meta-aggregates ~941 companies' postings onto its own pages with no link back to the employer (no canonical URL, rules 2 and 5); `robots.txt` disallows `/api/` for every bot, including AI crawlers. | Browse jobyap.com's own filters by hand. Paste a posting here — it gets confirmed at the real employer before anything else, same as any aggregator hit. **Field note (2026-10-25):** a by-hand keyword search for DevOps/SRE/streaming roles came back thin (few relevant results at the time of checking), so it is worth a periodic look rather than a primary source. The one lead checked was a posting already available through another channel, which suggests JobYap mirrors postings that exist elsewhere rather than surfacing exclusive ones. |
| Upwork | Applying costs the freelancer "Connects" (fails the free-for-candidates rule); the job-search API needs an approved OAuth app. | Saved searches + email alerts inside your own account. Paste the gig text here for a fit check against your floor. **Field note (2026-10-25):** the "Artificial Intelligence" job category (the obvious first search for someone interested in AI infrastructure) is mostly a mismatch — ~1,647 listings skew to building chatbots/voice agents/AI SaaS features and prompt/automation work (median $35-60/hr quoted for "AI Engineer"), i.e. application-development and product work, not infra/ops. Search narrower, skill-matched categories instead: "DevOps", "Linux Server Administration", "Streaming", "Video Editing"/"DaVinci Resolve" — the site's own category pages for those line up with what a CV can actually back (see the "Gig fit" note above). The generic **"Video Editor"** category (7,783 listings) is also a poor match despite looking relevant on paper: it's saturated with low-budget social/UGC content work (TikTok reels, YouTube Shorts, "AI drama" ads), median $15-35/hr, often fixed-price $5-45 for a whole edit — a different, lower-rate market than broadcast/streaming-infra tooling. Narrow to "DaVinci Resolve", "Streaming", "Live Streaming" or "RTMP"/"Encoding" instead of the bare "Video Editor" category to reach gigs where an infrastructure background prices well. **Connects expiry (per Upwork support, 2026-10-25):** unused Connects expire exactly one year after being issued, whether or not the account was active, and expired Connects cannot be restored — a long-dormant account can see a large balance drop to 0 in one go. Check Account Settings → Membership and Connects periodically for upcoming expirations, and use "Earn Connects" / "Buy Connects" to top up rather than expecting a reversal. |
| Fiverr | No official buyer-request API found. | Check buyer-request notifications in your own account. Paste text here. **Field note (2026-10-25):** Fiverr has no public, searchable job-postings feed at all. Searching any skill keyword (e.g. "devops") on the main search returns **seller gigs** (people/agencies selling that service, priced from ~$5 to $500+), never buyer requests. Buyer Requests are a private, account-only feed (Fiverr menu → "Buyer Requests" as a seller), not reachable by search or URL, so there is nothing to scan here even in principle. A seller profile that has not finished onboarding (no published service, no ID verification) cannot open that feed, so finishing onboarding just to check it is a real time cost for a payoff that is likely small, given Fiverr's low-budget/content-gig skew (see the Upwork "Video Editor" note). Worth it only if you also want a Fiverr seller presence for its own sake, not purely as a job-search channel. |
| Glassdoor | A reference scraper for this board needs active bot-detection evasion (stealth mode) — out of scope on principle, independent of `robots.txt`. | Browse manually. It often mirrors a LinkedIn/Indeed posting, so confirming at the employer's own board is usually faster anyway. **Field note (2026-10-25):** Glassdoor is now owned/operated by Indeed, Inc. (its own footer says so: "'Glassdoor'... [is a] registered trademark... of Indeed, Inc."), which explains why its listings mirror Indeed almost exactly (same "Candidatura rápida" quick-apply flow, same postings turning up — postings seen on Indeed show up here identically). Sign-in with a Google account (OAuth) is offered, so no separate password is needed. **Genuine added value beyond duplicating Indeed:** employer review data on the posting page itself — overall rating, CEO-approval %, "recommend to a friend" %, and categorized pros/cons from real employee reviews. Worth a quick look for Block D/G company research on roles found through *other* channels too, even when not applying through Glassdoor. |
| Dice | Same stealth-mode requirement as Glassdoor. | Browse manually at dice.com (DHI Group); mostly US-based tech contracts. **Field note (2026-10-25):** not evaluated in depth; check its account and resume requirements the first time you use it, then browse a core keyword search as with the other sites in this table. |
| Jooble | A meta-aggregator across other boards (rule 5). | Skip — whatever it has is already covered by its source boards. |
| Arc.dev | Hides the employer behind "Arc Exclusive" on every listing (fails rule 1); applying needs an Arc account. | Skip unless you already have an Arc account and want to browse manually. |
| ArtStation Jobs | The job pages and the HTML listing answer 403 (Cloudflare challenge) to a declared client, so a single posting page can't be fetched by the scanner. The board-wide public JSON feed (`/api/v2/jobs/public/jobs.json`) is open and is read by `providers/artstation.mjs`, so the board itself *is* scanned once enabled. | Relevant to art, games, film and color-grading searches. Enable it with a `job_boards:` entry that sets `provider: artstation` (explicit-only, the host is not auto-claimed). The feed carries the remote and relocation flags, the full description and usually the employer's own `apply_link`, which becomes the posting URL; only when it has no usable link does the URL fall back to the ArtStation page. If you need a posting's ArtStation page itself, paste its text (or ask for `node browser-extract.mjs <url>`). |
| Mandy, Mediabistro, BroadcastJobs.com | Bot-blocked (403 / CAPTCHA), or `robots.txt` names Claude's crawler directly. | Relevant to media/crew roles. Browse manually; paste anything promising. |
| Catho (Brazil), Trabajando.com (Chile) | Push candidates to a paid tier (fails the no-paywall bar). | LatAm boards worth an occasional manual look if targeting those markets specifically. |
| Telegram job channels and job bots (e.g. @devops_jobs_feed, @gamedevjob; Getmatch's @g_jobbot) | Deliberately documented only, not enabled, even though the `telegram-channel` provider can read a public channel's `t.me/s/` preview. Posts come from anonymous publishers, the channel operator is unknown, and bot-based services require talking to a bot and handing a third party your data before you see anything. Channels also go stale and their handles get resold: `@remote_it`, still recommended in 2026 Russian-language round-ups, was found abandoned with its username listed for sale (2026-11-01). | **Field note (2026-11-01):** `@devops_jobs_feed` ("Devops Jobs — вакансии и резюме") was active (last post 2026-10-30), Russian/English, ~14 of 20 recent posts mention remote work, some with Gulf-region salaries — but it mixes job postings with candidates' own résumé posts. `@gamedevjob` ("Работа в геймдеве") was active (2026-10-28), mostly art/analyst roles, little infra. Read them by hand in Telegram if wanted; treat every post as unverified: identify the employer and confirm the role on the employer's own careers page before evaluating (same rule as any aggregator), and never send a CV to an anonymous handle. Getmatch matches IT candidates through its Telegram bot with an HR contact — only worth it if you accept giving that service your profile; it was not tried. Channels found while browsing can also point to ATS vendors rather than boards (e.g. JobAdder, an agency-side recruitment CRM with no candidate-wide account: you only meet it through a specific agency's posting). |

Everywhere in this table: paste the posting text or URL and it gets triaged/evaluated exactly like a scanned one — manual discovery skips the scan step, not the funnel. Ask for a re-check of this filtered list if targeting changes (a new country, a new role type) — the full table in `SUPPORTED_JOB_BOARDS.md` may already have something relevant that was left out here as not applicable at the time.

LinkedIn is handled differently: it is not in this table because it is scanned/read under a bounded guard (one browser attempt per posting per run, then ask for pasted text — see AGENTS.md's LinkedIn JD loading guard), not skipped outright.

## 4. When a site blocks the agent

1. Say so plainly and name the site.
2. Do not work around the block (no header spoofing, no retries with another tool).
3. Ask for the pasted posting text, and treat it as untrusted data like any other posting.
4. Record the blocked source in the tracker note or the evaluation's verification line, so the next run does not repeat the attempt.

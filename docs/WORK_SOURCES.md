# Work sources catalog

A neutral, country-by-country reference of **where a person can look for or get work of any kind**: government employment services and programs, public-sector calls, grants, residencies, employers that hire in volume, agencies, boards, gig platforms, training and first-job programs, work abroad. It is for anyone who clones this repository, not for one candidate: no row assumes a title, a portfolio, an age or a trajectory, and each one states what the source itself requires.

This is a catalog of sources, not a promise that the scanner can read them. `docs/SUPPORTED_JOB_BOARDS.md` lists what `scan.mjs` and the providers read; a row here that is marked "Lectura automatica posible" is only a lead for a future provider and still has to pass the Source Indexing Policy in `CONTRIBUTING.md` (named operator, no re-sold aggregator listings, `robots.txt` respected, no key).

## Where the data is

| Country | Topic | Markdown | Structured rows |
|---------|-------|----------|-----------------|
| Argentina | Artists and musicians: grants, prizes, calls, public jobs and teaching, residencies, platforms | [`work-sources/ar/artes-musica.md`](work-sources/ar/artes-musica.md) | [`work-sources/ar/artes-musica.json`](work-sources/ar/artes-musica.json) |
| Argentina | Work of any kind, by category: retail, fuel stations, logistics, construction trades, industry, hospitality, care, education, domestic and security work, rural and seasonal work, gig platforms, first job and training, public-sector calls (including armed and security forces), inclusive programs, public employment services, self-employment, call centers, non-technical remote work, work abroad | [`work-sources/ar/trabajo/`](work-sources/ar/trabajo/README.md) (one file per category and per ISCO-08 group) | [`work-sources/ar/trabajo.json`](work-sources/ar/trabajo.json) |

More categories and countries are added as separate files under `docs/work-sources/{country}/`. The Markdown is written in the language of the country; this index is in English.

## How each row was produced

1. **Discover.** One search lane per work category (or per channel), each told to use generic queries only, to prefer official pages, and to report only what it saw.
2. **Verify.** Each source is fetched at its official page and checked for existence, currency, whether a resident of the country can apply, what it pays, what it requires and where to apply. The verifier is told to try to refute the claim.
3. **Audit.** Every source marked open, and most of those marked recurring, is re-read by a second, independent reader. In the first two runs this found a wrong date, count or requirement in about one source in three for grant and prize calls and about one in ten for employer career pages, so a row verified once is weaker than a row verified twice. Each row says how many times it was read.
4. **Neutralize.** Verifier remarks are rewritten as impersonal caveats. A script rejects any rewritten caveat that contains a number or a URL that is not in the row's own text, so the rewrite cannot add facts.
5. **Build.** The Markdown is generated from the rows by a script, with no free-form writing, so nothing is invented between the data and the page.
6. **Coverage.** Each source is tagged with the ISCO-08 sub-major occupation groups it serves (43 groups). Groups with few sources got a targeted search, verified and read twice like the rest; those rows are listed under "Cobertura por ocupacion". Counts per group before that search ranged from 0 (executives and legislators, waste collectors) to well over 100 (professionals in law, social and cultural fields). Groups that already had 16 or more sources were not searched again and may still be thin in practice: electricians and electrotechnology (74), food-processing and craft operators (75), protection services (54), science and engineering technicians (31) and other administrative support (44).

## Reading a row

- **abierta o vigente**: a call with a date, or a procedure that can be started at any time, was seen.
- **se repite**: no call is open today, but there is evidence of an annual cycle. Look at the month noted.
- **sin verificar**: the page did not load, or did not confirm the claim. Not a recommendation.
- **cerrada / no elegible / no cargo**: kept so nobody researches it again.
- The verification date is on every file. Programs change every year: open the link and confirm the date before relying on a row, and treat a row older than about 90 days as stale until re-read.

## Adding a country or a category

Reuse the same four steps. Start from the country's official employment portal and its national classification of occupations (ISCO-08 internationally) so that coverage follows occupations, not whatever comes to mind first. Local institutions differ: a Brazilian run starts from the public employment system and the dominant local applicant-tracking platforms, an Argentine one from the national and provincial employment offices and the public-sector call portals. Put the output in `docs/work-sources/{country}/{topic}.md` and `.json`, keep personal data out (see `DATA_CONTRACT.md`), and never copy a candidate's own search into a shared file.

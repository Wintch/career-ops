# How to add a country or a category

This folder holds the pieces used to build `docs/work-sources/{country}/`. It is here so that anyone can extend the catalog to another country, or re-verify an existing one, without starting from scratch. Nothing in it is tied to a person: it takes a country, a language and a list of work categories.

The workflow scripts run with Claude Code's `Workflow` tool (JavaScript, one agent per lane, web search and fetch). The builder is plain Python 3 with no dependencies. Porting the builder to `.mjs` with tests is still open.

## Pieces

| File | Role |
|------|------|
| `workflows/work-sources-country.js` | Discover and verify sources for one country. Lanes: retail, fuel, logistics, trades, industry, hospitality, care, education, domestic-security, agri-seasonal, gig, first-job, public-sector, inclusive, employment-services, self-employment, call-center-admin, remote-nontech, abroad. Args: `today`, `country`, `languageNote`, `laneKeys`, `hints` (one sentence per lane with the local institutions and employers to look for). |
| `workflows/audit-sources-by-file.js` | Second, independent read of every open or recurring row. Args: `file`, `count`, `today`, `scope`, `size`, `language`. |
| `workflows/neutralize-catalog-notes.js` | Rewrites verifier remarks as impersonal caveats. Args: `file`, `count`, `size`, `language`. |
| `workflows/isco-coverage-gapfill.js` | Tags rows with ISCO-08 sub-major groups and searches the groups that are thin. Args: `file`, `count`, `today`, `country`, `language`, `minGood`, `maxLanes`, `only`. |
| `workflows/arts-music-country.js` | Same idea for artists and musicians: grants, prizes, calls, public jobs, residencies, platforms. |
| `builder/country_merge.py` | Merges a second batch into the first: drops duplicates by URL and by name, and writes the rows that still need the second read. |
| `builder/audit_convert.py` | Turns the audit workflow output into url-keyed results. |
| `builder/caveat_keys.py` | Turns the neutralize output into caveats keyed by `url|name`, and lists rows the neutralizer judged out of scope. |
| `builder/build_catalog.py` | Deterministic builder: rows plus audits to Markdown and JSON. No free-form text is written here. It applies the guards below. |
| `builder/localize_pt.py` | Spanish labels to Portuguese (fixed labels only; the row text is already in the country's language). |
| `builder/split_catalog.py` | Splits the Markdown into one file per category and ISCO group plus a README index, because GitHub does not render files above about 512 KB. |
| `builder/finalize_country.sh` | build, optional localization, split. Set `WORK_DIR` to the folder with the rows and the scripts. |
| `builder/supported-hosts.json` | Hosts the scanner already reads (from `docs/SUPPORTED_JOB_BOARDS.md`), used to mark "Lectura automatica posible" honestly. |

## Steps for a new country

1. **Discover and verify.** Run `work-sources-country.js` in two batches: A (retail, fuel, logistics, trades, industry, hospitality, care, education, domestic-security, agri-seasonal, gig) and B (first-job, public-sector, inclusive, employment-services, self-employment, call-center-admin, remote-nontech, abroad). Write the `hints` from the country's own institutions: the public employment service, the civil-service call portal, the training institute, the dominant boards and applicant-tracking platforms, the biggest employers per category.
2. **Merge** B into A with `country_merge.py`.
3. **Audit.** Run `audit-sources-by-file.js` on the open and recurring rows B added, and convert with `audit_convert.py`. Expect a wrong date, count or requirement in roughly one source in ten for employer pages and one in three for grant calls.
4. **Neutralize** every row with `neutralize-catalog-notes.js`, then `caveat_keys.py`.
5. **Build** with `finalize_country.sh`, and add one row to `docs/WORK_SOURCES.md`.
6. **Coverage.** Run `isco-coverage-gapfill.js` for the groups that stayed thin and rebuild.
7. **Gates before any push.** `node clean-markers.mjs audit` on the new files, a link check between the files, the three docs tests (`tests/docs-only-change.test.mjs`, `tests/agent-docs-script-refs.test.mjs`, `tests/no-user-data-batch-guard.test.mjs`) and a grep for personal data.

## Guards that are part of the method

- Every URL, number and email in a caveat must already exist in the row's own text, so the rewrite cannot add facts.
- First-person phrases, time-relative phrases ("tomorrow", "this week") and rows judged out of scope (political training, reference libraries, not a way to get work) are dropped.
- A source that did not load is marked `sin verificar` and never presented as a recommendation. A source blocked to automated reads (HTTP 403) is kept only if a search result or the employer's page on a major board shows live postings, and is flagged as not directly verified.
- Countries where fake job offers are common (and where official sites are often down) carry the fraud warnings found in official or widely reported sources, in the row's own notes.
- A candidate's own search never goes into these files. Keep it in your own `portals.yml`, `config/profile.yml` and `data/`.

## Known limits

- Web search from the verifier is US-centered and thin for other countries, and it has a quota: when it runs out, more rows come back as `sin verificar`. The catalog records that instead of filling the gap.
- A second read reduces errors but does not remove them. Programs change every year; confirm the date on the link before relying on a row.
- ISCO-08 coverage passes exist for Argentina and Brazil. Other countries are covered by category only until a pass is run.

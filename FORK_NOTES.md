# About this fork

This is the `personalized` branch of [career-ops](https://github.com/career-ops-hq/career-ops) — a generic starting point anyone can build on, whatever they're job-hunting for. Nothing here is specific to IT/tech; the scoring and matching logic works from whatever role keywords you put in `title_filter.positive`, in any field.

## What's different from upstream

- **`portals.yml` is tracked here** (it's gitignored upstream by design, since it's normally user config). This one is the stock example template plus one extra regional block: **Argentina job portals** (Computrabajo, Bumeran, ZonaJobs, LinkedIn) — a working example of adding a country/market that wasn't already covered. Everything else is the shipped template defaults, including its already-generic role examples (AI/ML, engineering, and commented-out Healthcare/Finance/Marketing sections) — swap those for your own target roles.
- **`profile-git`** — a small wrapper script that versions your actual personal files (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `portals.yml` if you customize it) in a *separate, local-only* git repo next to this one, with no remote. Nothing in that repo ever leaves your machine unless you explicitly add a remote yourself. Usage is in the script's header comment.
- A one-line `.gitignore` fix (`data/agent-inbox.md`) — also submitted upstream as its own PR.

## What's NOT here (on purpose)

No personal targeting, no biographical details, no real names, no specific companies researched by anyone. Everything normally gitignored stays gitignored: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `voice-dna.md`, `reports/`, `data/`, `interview-prep/`, `documents/`, `writing-samples/`. See `DATA_CONTRACT.md` in the upstream repo for the full boundary.

## If you fork this fork

Read the top of `portals.yml` — it walks you through editing `title_filter.positive` for your own target roles (design, marketing, healthcare, whatever) and adding/removing companies in `tracked_companies`. Run `./profile-git status` to start your own private, unshared history for your personal files.

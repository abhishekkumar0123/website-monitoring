# Website Monitoring (All Pages + JS Assets)

This repo is a **snapshot-based website monitor**: a GitHub Action periodically fetches a target website, commits the latest HTML/JS snapshots, and can notify on changes.

## What gets monitored

- **All internal pages** (discovered via `sitemap.xml` when available, otherwise via link crawling)
- **All JS assets** referenced by those pages via `<script src="...">`

Artifacts:

- `pages/`: HTML snapshots (one file per URL path)
- `assets/`: downloaded assets (including `/_next/...` etc)
- `manifest.json`: list of fetched URLs/assets + errors (helps reviewing diffs)

## GitHub Action configuration

The workflow uses `scripts/monitor.mjs`. You can tweak behavior with env vars:

- `TARGET_URL` (default: `https://zerobounce.net/`)
- `MAX_PAGES` (default: `200`)
- `MAX_ASSETS` (default: `2000`)
- `FETCH_TIMEOUT_MS` (default: `25000`)
- `SAME_ORIGIN_ONLY` (default: `true`)
- `ALLOW_QUERY_URLS` (default: `false`)

## Local run

```bash
node scripts/monitor.mjs
```


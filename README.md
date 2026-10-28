# Extendo

Chrome (MV3) extension that builds a table in the side panel by joining page A's
issuer/series table with deal data from page B (dv01).

## Daily use

1. Log into page B in a tab.
2. Open page A in another tab and focus it.
3. Click the Extendo toolbar icon → **Build table**.
4. Optionally **Copy (TSV)** and paste into a spreadsheet.

## How it works

- **Page B**: the API call is run *inside* the open B tab (`chrome.scripting`, MAIN world),
  so it uses B's own logged-in session. No token is extracted or stored.
- **Page A**: the table lives in an iframe; a read-only extractor runs in every frame and
  picks the first `<table>` with the configured issuer/series headers.
- **Join**: `data/deal-map.json` maps (issuer, series) → B deal id. Matching ignores case
  and extra whitespace. Rows that aren't in the map, or whose deal B didn't return, are listed
  separately below the main table.

## Setup

1. Fill in `config.js`: page URLs, B's API endpoint and response shape, A's column headers,
   and the output columns.
2. Put the same URL patterns in `manifest.json` → `host_permissions`, **including the
   origin of page A's iframe** (check its `src` in DevTools).
3. Populate `data/deal-map.json`.
4. `chrome://extensions` → Developer mode → **Load unpacked** → select this folder.
   After editing files, click the reload icon on the extension card.

To find B's API: open B with DevTools → Network → Fetch/XHR, find the request that returns
deal data, and copy its URL and response shape. If it uses a `Bearer` token rather than
cookies, add the header in `fetchFromB` in `injected.js`.
# extendo

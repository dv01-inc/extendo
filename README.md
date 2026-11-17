# Extendo

Chrome (MV3) extension that builds a table in the side panel by joining Citi's
issuer/series table with deal data from SecOps (dv01).

## How to Install Extendo

1. Have a Chrome browser
2. Download `extendo-vX.Y.Z.zip` from the latest release at
   https://github.com/dv01-inc/extendo/releases/latest and unzip it.
3. Open chrome://extensions/ in a tab
4. In the upper right hand side of the Extensions page there is a **Developer mode** switch, turn it on.
5. In the upper right hand side of the Extensions page there will now be a **Load unpacked** button, click it.
6. Select the unzipped `extendo` folder.

You should see a new extension called Extendo.  You should now see a Gray E icon on the right side of the nav bar.

To update, download the newer zip, replace the folder, and click the reload icon on the
Extendo card. The version is shown on the card and in the side panel's tab bar.

## Versions and dev builds

Every PR merged into `main` triggers `.github/workflows/release.yml`, which bumps
`manifest.json`'s version, tags it `vX.Y.Z`, and publishes a release zip.

- Bump size comes from PR labels: `major`, `minor`, otherwise patch. Label a PR
  `no-release` to skip the release.
- Don't edit `version` by hand; the workflow owns it.
- The repo's `manifest.json` is always the **dev build**: it's named "Extendo (dev)" and its
  `version_name` is `X.Y.Z-dev`. Loading the repo folder unpacked shows that name, an
  orange **DEV** badge on the toolbar icon, and an orange version tag in the side panel.
  Release zips are named "Extendo" with a plain version and no badge.
- Dev and release copies have different extension IDs, so they can be installed side by
  side, but they don't share local storage: Mappings edits in one don't appear in the
  other. Use **Export JSON** / **Import JSON** to move them.

## How to Use Extendo to Download Deals on Citi's website

After you have installed Extendo on your Chrome browser
1. Log into SecOps in a browser tab.
2. Open the Citi page in another tab, log into it.
3. Click the Extendo toolbar icon (Gray E on the right of the nav bar) → **Downloads** → **Build table**.

The side panel has three tabs:

- **Downloads**: the joined table. Click a deal to open it on Citi and download its
  latest statement. Citi rows missing from the deal map have a **Map…** link.
- **Issues**: Citi deals from SecOps (`config.js` → `issues.include`) that no deal map
  entry points to. Filled in by **Build table**, or fetch on its own. **Map…** opens the
  Mappings tab with a suggested entry (issuer guessed from other deals on the same shelf).
- **Mappings**: edit the deal map in place: add, edit (changes save when a field loses
  focus), remove, filter. Edits are saved in the extension's local storage and apply
  immediately to the other tabs. **Export JSON** downloads the map in the same format as
  `data/deal-map.json`; commit it there to share it or keep it as the default. **Reset**
  discards local edits and reloads `data/deal-map.json`.

## Testing locally with mock sites

`dev/mock-server.py` serves stand-ins for Citi and SecOps on localhost, so you can test
changes without logging in to either. It needs only Python 3, and the fake data is in
`dev/fixtures.json`.

1. `python3 dev/mock-server.py`
2. In `config.js`, set `const MOCK_CITI = true;` and `const MOCK_SECOPS = true;`, then
   reload Extendo in `chrome://extensions`. The side panel's version tag shows which sites
   are mocked (e.g. **MOCK Citi + SecOps**). Don't commit either as true; the release
   workflow rejects it.
3. Open http://localhost:8766/ (SecOps) and click **Sign in as alice**.
4. Open http://localhost:8765/ (Citi), then **Build table** in the side panel.

The switches are independent, so you can mock one site against the real other. For
example, `MOCK_CITI = true` with `MOCK_SECOPS = false` reads the mock Citi table and calls
the real SecOps (log in at secops-dashboard.dv01.cloud instead of step 3). Mock Citi rows
only match if `data/deal-map.json` maps them to deals real SecOps returns; otherwise they
show up under the problem lists below the table.

What the mock data covers:

- **Downloads**: matched rows (Waiting rows sort first), a row matched despite case and
  whitespace differences, a mapped deal that SecOps doesn't return, and an unmapped row
  with **Map…**. Clicking a deal opens its Reports page in the iframe (after a 1s delay)
  and offers the Oct 2026 Certificate Holders Statement as a PDF. JPMMT 2024-10 has no
  statement.
- **Issues**: two unmapped Citi deals. COLT 2026-9 gets a suggested issuer and EXMT 2026-1
  doesn't. A non-Citi deal is filtered out.
- **SecOps login**: each tab keeps its own token, so two tabs can be signed in as alice
  and bob. **Expire session** makes the next API call return 401 without the page
  noticing. **Log out** navigates to a sign-out page on another origin. The server log
  shows which token each request carried.

The mock hosts are in the dev `manifest.json`'s `host_permissions`; release zips leave
them out.

## How it works

- **SecOps**: the API call is run *inside* the open SecOps tab (`chrome.scripting`, MAIN world),
  so it uses SecOps's own logged-in session. The dashboard's `Authorization` header is also
  copied from its own requests (`background.js`) and kept in memory only
  (`chrome.storage.session`), tied to that tab. It's used only to call the API directly if
  no SecOps tab can run the request, and it's dropped when that tab closes, leaves SecOps,
  or gets a 401. It's never written to disk or sent to another tab.
- **Citi**: the table lives in an iframe; a read-only extractor runs in every frame and
  picks the first `<table>` with the configured issuer/series headers.
- **Join**: the deal map (edited in the Mappings tab, seeded from `data/deal-map.json`) maps
  (issuer, series) → SecOps deal id. Matching ignores case
  and extra whitespace. Rows that aren't in the map, or whose deal SecOps didn't return, are listed
  separately below the main table.

## Setup

1. Fill in `config.js`: page URLs, SecOps's API endpoint and response shape, Citi's column headers,
   and the output columns.
2. Put the same URL patterns in `manifest.json` → `host_permissions`, **including the
   origin of Citi's iframe** (check its `src` in DevTools).
3. Populate `data/deal-map.json`.
4. `chrome://extensions` → Developer mode → **Load unpacked** → select this folder.
   After editing files, click the reload icon on the extension card.

To find SecOps's API: open SecOps with DevTools → Network → Fetch/XHR, find the request that returns
deal data, and copy its URL and response shape. If it uses a `Bearer` token rather than
cookies, add the header in `fetchFromSecOps` in `injected.js`.
# extendo

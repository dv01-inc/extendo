import { CONFIG } from './config.js';
import { downloadLink, extractTable, fetchFromSecOps, findLatestStatements, followLink } from './injected.js';
import { getCell, getField, joinRows, mapKey, project, suggestMapping, unmappedDeals } from './join.js';
import { isEdited, loadMap, resetMap, saveMap } from './mapstore.js';

const $ = (id) => document.getElementById(id);
let lastTsv = '';
// The deal map being edited in the Mappings tab; every tab reads it from here.
let mapEntries = [];
// Inputs of the last build, kept so map edits can redo the join without refetching.
let lastBuild = null;
// Deals from the last SecOps fetch (by either tab).
let lastDeals = null;

function setStatus(text, isError = false, id = 'status') {
  $(id).textContent = text;
  $(id).classList.toggle('error', isError);
}

// Show the build in the tab bar, e.g. "v1.0.1" or "v1.0.1-dev" (highlighted).
{
  const { version, version_name: name = version } = chrome.runtime.getManifest();
  const mocked = [CONFIG.mock.citi && 'Citi', CONFIG.mock.secOps && 'SecOps'].filter(Boolean);
  $('version').textContent = `v${name}${mocked.length ? ` · MOCK ${mocked.join(' + ')}` : ''}`;
  $('version').classList.toggle('dev', name.endsWith('-dev') || mocked.length > 0);
}

// --- Tabs ---

function showTab(name) {
  for (const tab of document.querySelectorAll('[role=tab]')) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    $(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.addEventListener('click', () => showTab(tab.id.replace('tab-', '')));
}

// Must be the first await of a click handler so it still counts as part of the click. If
// site access was restricted (e.g. "On click"), this prompts once; otherwise it resolves
// silently.
async function requestHostAccess() {
  const granted = await chrome.permissions.request({ origins: chrome.runtime.getManifest().host_permissions });
  if (!granted) throw new Error('Extendo needs access to Citi and SecOps.');
}

// Prefer the active matching tab in the focused window, else any matching tab.
async function findTab(urlMatch) {
  const [active] = await chrome.tabs.query({ url: urlMatch, active: true, lastFocusedWindow: true });
  if (active) return active;
  const [any] = await chrome.tabs.query({ url: urlMatch });
  return any;
}

// Run the API call inside a SecOps tab (most recently used first) so it carries SecOps's
// session. A tab that can't run it, or whose request fails (e.g. signed out), doesn't stop
// the search: the next tab is tried. If none succeeds, call the API from the extension
// itself with the Authorization header captured in background.js.
//
// The captured token is only sent to the tab it came from (background.js clears it when
// that tab's login ends), so one tab's login is never replayed in another.
async function callSecOps(secOpsAuth) {
  const tabs = await chrome.tabs.query({ url: CONFIG.secOps.urlMatch });
  tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  const failures = [];
  // The most useful failed response so far: an auth error beats any other.
  let errorResult;
  const keepError = (result) => {
    const isAuth = (r) => r?.status === 401 || r?.status === 403;
    if (!errorResult || (isAuth(result) && !isAuth(errorResult))) errorResult = result;
  };

  for (const tab of tabs) {
    if (tab.discarded) {
      failures.push(`tab ${tab.id} asleep`);
      continue;
    }
    let result;
    try {
      [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: fetchFromSecOps,
        args: [CONFIG.secOps.apiUrl, secOpsAuth?.tabId === tab.id ? secOpsAuth.value : undefined],
      });
    } catch (e) {
      failures.push(`tab ${tab.id} (${tab.url}, status ${tab.status}): ${e.message}`);
      continue;
    }
    if (!result) {
      failures.push(`tab ${tab.id}: no result (page navigated?)`);
      continue;
    }
    if (!result.error) return result;
    failures.push(`tab ${tab.id}: ${result.error}`);
    keepError(result);
  }
  console.log('Extendo: SecOps tabs', tabs.length, 'failures', failures);

  if (secOpsAuth) {
    console.log('Extendo: calling SecOps API directly from the extension');
    const result = await fetchFromSecOps(CONFIG.secOps.apiUrl, secOpsAuth.value);
    if (!result.error) return result;
    keepError(result);
  }
  if (errorResult) return errorResult;
  throw new Error(
    tabs.length
      ? 'Could not run in the SecOps tab and no login token captured yet. Reload the SecOps tab, then retry.'
      : 'No SecOps tab found. Open SecOps and log in first.',
  );
}

async function loadDeals() {
  const { secOpsAuth } = await chrome.storage.session.get('secOpsAuth');
  const result = await callSecOps(secOpsAuth);
  if (result.error) {
    console.log('Extendo: SecOps error', result.error);
    if (result.status === 401 || result.status === 403) {
      throw new Error(
        secOpsAuth
          ? `SecOps rejected the login token captured ${new Date(secOpsAuth.capturedAt).toLocaleTimeString()} ` +
              '(probably expired). Reload the SecOps tab, then retry.'
          : 'No SecOps login token captured yet. Reload the SecOps tab so the dashboard makes its API calls, then retry.',
      );
    }
    throw new Error(result.error);
  }
  let deals = getField(result.data, CONFIG.secOps.dealsPath);
  if (!CONFIG.secOps.dealsPath && deals && !Array.isArray(deals)) {
    deals = Object.values(deals).find(Array.isArray);
  }
  if (!Array.isArray(deals)) throw new Error('SecOps response did not contain a deals array (check dealsPath).');
  console.log('Extendo: sample deal from SecOps', deals);
  return deals;
}

async function loadCitiTable() {
  const tab = await findTab(CONFIG.citi.urlMatch);
  if (!tab) throw new Error('No Citi tab found. Open Citi first.');

  // The table is inside an iframe. Inject frame by frame: with allFrames, one frame on a
  // host we lack permission for fails the whole call.
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  const blocked = [];
  for (const frame of frames) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [frame.frameId] },
        func: extractTable,
        args: [[CONFIG.citi.issuerColumn, CONFIG.citi.seriesColumn]],
      });
      if (result) return { tabId: tab.id, frameId: frame.frameId, rows: result.rows };
    } catch (e) {
      blocked.push(frame.url);
    }
  }
  console.log('Extendo: Citi frames', frames.map((f) => f.url), 'blocked', blocked);
  throw new Error(
    `No table with "${CONFIG.citi.issuerColumn}" and "${CONFIG.citi.seriesColumn}" columns found on Citi.` +
      (blocked.length ? ` Frames not readable (add their hosts to host_permissions): ${blocked.join(', ')}` : ''),
  );
}

function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Try to follow `href` (or run another link action such as downloadLink) in whichever
// frame of Citi currently shows it. Frames are re-listed every time because Citi's
// iframes are replaced as it navigates.
async function tryFollowLink(tabId, href, action = followLink) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  for (const frame of frames) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: action,
        args: [href],
      });
      if (result) return true;
    } catch {
      // Frame is mid-navigation or not readable; try the next one.
    }
  }
  return false;
}

// Poll until the link can be followed (the table is back) or `timeoutMs` passes.
async function waitAndFollowLink(tabId, href, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tryFollowLink(tabId, href)) return true;
    await sleep(500);
  }
  return false;
}

// Poll Citi's frames until one shows the Reports page (any configured section heading), or
// `timeoutMs` passes. Returns the latest file of each section found there, or null.
async function waitForStatements(tabId, timeoutMs) {
  const labels = CONFIG.citi.statements.map((s) => s.label);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    for (const frame of frames) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          func: findLatestStatements,
          args: [labels],
        });
        if (result) return result;
      } catch {
        // Frame is mid-navigation or not readable; try the next one.
      }
    }
    await sleep(500);
  }
  return null;
}

// Sections ticked the last time the download question was answered Yes, saved in
// chrome.storage.local. Until the first Yes, the sections marked `default: true` in config.
const PICKS_KEY = 'statementPicks';
async function loadPicks() {
  const { [PICKS_KEY]: saved } = await chrome.storage.local.get(PICKS_KEY);
  return new Set(saved ?? CONFIG.citi.statements.filter((s) => s.default).map((s) => s.label));
}

// Ask which of a deal's files to download, as a checkbox per configured section: files found
// start ticked if their section is in `picks`, sections the deal lacks are shown disabled.
// Resolves to the ticked files, or null for No. A newer question (from another deal click)
// answers the pending one with No.
let answerPrompt = null;
function askWhichFiles(files, picks) {
  answerPrompt?.(null);
  const choices = [];
  const update = () => {
    const n = choices.filter((c) => c.box.checked).length;
    $('prompt-text').textContent =
      n === 0 ? 'No files ticked.' : n === 1 ? 'Download this file?' : `Download these ${n} files?`;
    $('prompt-yes').disabled = n === 0;
  };
  const items = CONFIG.citi.statements.map(({ label }) => {
    const file = files.find((f) => f.label === label);
    const box = el('input');
    box.type = 'checkbox';
    const row = el('label');
    if (file) {
      box.checked = picks.has(label);
      box.addEventListener('change', update);
      choices.push({ box, file });
      row.append(box, file.title);
    } else {
      box.disabled = true;
      row.className = 'unavailable';
      row.append(box, `${label} (not on this deal)`);
    }
    const li = el('li');
    li.appendChild(row);
    return li;
  });
  $('prompt-list').replaceChildren(...items);
  $('prompt-list').hidden = false;
  update();
  $('prompt').hidden = false;
  return new Promise((resolve) => {
    answerPrompt = (yes) => {
      answerPrompt = null;
      $('prompt').hidden = true;
      resolve(yes ? choices.filter((c) => c.box.checked).map((c) => c.file) : null);
    };
  });
}
$('prompt-yes').addEventListener('click', () => answerPrompt?.(true));
$('prompt-no').addEventListener('click', () => answerPrompt?.(false));

const DOWNLOAD_GAP_MS = 500;

// After a deal opens on Citi, offer the latest file of each report section on it to pick from.
async function offerLatestStatements(tabId) {
  setStatus('Looking for the latest reports…');
  const found = await waitForStatements(tabId, 15000);
  if (!found) {
    setStatus('Opened deal on Citi. No report sections found on it.');
    return;
  }
  const missing = CONFIG.citi.statements.map((s) => s.label).filter((l) => !found.some((f) => f.label === l));
  console.log('Extendo: report sections', found, 'missing', missing);
  if (!found.length) {
    setStatus('Opened deal on Citi. Its report sections have no files.');
    return;
  }
  setStatus('Opened deal on Citi.');

  const picks = await loadPicks();
  const files = await askWhichFiles(found, picks);
  if (!files) return;
  // Remember the choice for the sections this deal offered; sections it lacked keep their
  // previous state, since they couldn't be changed here.
  for (const f of found) picks.delete(f.label);
  for (const f of files) picks.add(f.label);
  await chrome.storage.local.set({ [PICKS_KEY]: [...picks] });

  const failed = [];
  for (const [i, file] of files.entries()) {
    // Space the downloads out; Chrome may drop clicks that arrive together.
    if (i > 0) await sleep(DOWNLOAD_GAP_MS);
    setStatus(`Downloading ${i + 1} of ${files.length}: ${file.title}…`);
    if (!(await tryFollowLink(tabId, file.href, downloadLink))) failed.push(file.title);
  }
  setStatus(
    failed.length
      ? `Could not find these links anymore: ${failed.join(', ')}.`
      : `Downloading ${files.length} file${files.length === 1 ? '' : 's'}.`,
    failed.length > 0,
  );
}

// Follow a link from Citi's table. If Citi has moved on from the table (e.g. a previous
// click opened a deal), go back until the table is showing again, then follow it.
const MAX_BACK_STEPS = 3;
async function openOnCiti(citiTable, href) {
  const { tabId } = citiTable;
  answerPrompt?.(null);
  try {
    let opened = await tryFollowLink(tabId, href);
    for (let step = 1; !opened && step <= MAX_BACK_STEPS; step++) {
      setStatus('Returning to the deal list on Citi…');
      await chrome.tabs.goBack(tabId);
      opened = await waitAndFollowLink(tabId, href, 8000);
    }
    if (!opened) throw new Error('could not find the deal list. Go back to it on Citi, then retry.');
    await chrome.tabs.update(tabId, { active: true });
    await offerLatestStatements(tabId);
  } catch (e) {
    setStatus(`Could not open deal on citi: ${e.message}`, true);
  }
}

// Cells are strings, or {text, onClick} for links.
function renderTable(headers, rows) {
  const table = el('table');
  const headRow = table.createTHead().insertRow();
  headers.forEach((h) => headRow.appendChild(el('th', h)));
  const body = table.createTBody();
  rows.forEach((cells) => {
    const tr = body.insertRow();
    cells.forEach((c) => {
      const td = tr.insertCell();
      if (typeof c === 'string') {
        td.textContent = c;
      } else {
        const a = el('a', c.text);
        a.href = '#';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          c.onClick();
        });
        td.appendChild(a);
      }
    });
  });
  const wrap = el('div');
  wrap.className = 'scroll';
  wrap.appendChild(table);
  return wrap;
}

function renderProblems(title, headers, rows) {
  const details = el('details');
  details.appendChild(el('summary', `${title} (${rows.length})`));
  details.appendChild(renderTable(headers, rows));
  return details;
}

function render({ matched, unmapped, missingDeal }, citiTable) {
  const headers = CONFIG.output.map((c) => c.label);
  const sortCol = CONFIG.output.findIndex((c) => c.sort);
  if (sortCol >= 0) {
    // Sort on the projected text ('true' > 'false'); the sort is stable, so ties keep
    // Citi's order.
    const dir = CONFIG.output[sortCol].sort === 'desc' ? -1 : 1;
    const key = (m) => project(m, CONFIG.output)[sortCol];
    matched = [...matched].sort((x, y) => dir * key(x).localeCompare(key(y), undefined, { numeric: true }));
  }
  const rows = matched.map((m) => project(m, CONFIG.output));
  lastTsv = [headers, ...rows].map((r) => r.map((c) => c.replace(/[\t\n]/g, ' ')).join('\t')).join('\n');

  const cells = rows.map((r, i) =>
    r.map((text, j) => {
      const href = CONFIG.output[j].linkFrom && getCell(matched[i].citi._links ?? {}, CONFIG.output[j].linkFrom);
      return href ? { text, onClick: () => openOnCiti(citiTable, href) } : text;
    }),
  );

  const result = $('result');
  result.replaceChildren(renderTable(headers, cells));
  if (unmapped.length) {
    result.appendChild(
      renderProblems(
        'Not in deal map',
        ['Issuer', 'Series', ''],
        unmapped.map((u) => [
          u.issuer ?? '',
          u.series ?? '',
          { text: 'Map…', onClick: () => startMapping({ issuer: u.issuer ?? '', series: u.series ?? '', dealId: '' }) },
        ]),
      ),
    );
  }
  if (missingDeal.length) {
    result.appendChild(
      renderProblems(
        'Mapped, but deal not returned by SecOps',
        ['Issuer', 'Series', 'Deal ID'],
        missingDeal.map((m) => [m.issuer ?? '', m.series ?? '', m.dealId]),
      ),
    );
  }
  $('copy').disabled = rows.length === 0;
}

// Join the last build against the current deal map and show it.
function renderBuild() {
  if (!lastBuild) return;
  const { citiTable, deals, builtAt } = lastBuild;
  const joined = joinRows({
    citiRows: citiTable.rows,
    deals,
    mapEntries,
    issuerColumn: CONFIG.citi.issuerColumn,
    seriesColumn: CONFIG.citi.seriesColumn,
    dealIdField: CONFIG.secOps.dealIdField,
  });
  render(joined, citiTable);
  const source = deals ? `${deals.length} deals from SecOps` : 'deal map only, SecOps not checked';
  setStatus(
    `${joined.matched.length} of ${citiTable.rows.length} rows matched · ${source} · ` + builtAt.toLocaleString(),
  );
}

// withSecOps false: build from Citi's table and the deal map alone (no SecOps login needed);
// SecOps-derived columns show their `noSecOps` value.
async function run(withSecOps) {
  const buttons = [$('run'), $('run-no-secops')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await requestHostAccess();
    let deals = null;
    if (withSecOps) {
      setStatus('Fetching deals from SecOps…');
      deals = await loadDeals();
    }
    setStatus('Reading table from Citi…');
    const citiTable = await loadCitiTable();
    lastBuild = { citiTable, deals, builtAt: new Date() };
    if (deals) {
      lastDeals = { deals, fetchedAt: lastBuild.builtAt };
      renderIssues();
    }
    renderBuild();
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

$('run').addEventListener('click', () => run(true));
$('run-no-secops').addEventListener('click', () => run(false));
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(lastTsv);
  setStatus('Copied to clipboard. Paste into Excel or Sheets.');
});

// --- Issues ---

function renderIssues() {
  if (!lastDeals) return;
  const { deals, fetchedAt } = lastDeals;
  const missing = unmappedDeals({
    deals,
    mapEntries,
    dealIdField: CONFIG.secOps.dealIdField,
    include: CONFIG.issues.include,
  });
  const badge = $('issue-count');
  badge.textContent = String(missing.length);
  badge.hidden = missing.length === 0;

  const total = deals.filter(CONFIG.issues.include).length;
  setStatus(
    `${missing.length} of ${total} matching SecOps deals are not in the deal map · fetched ` +
      fetchedAt.toLocaleString(),
    false,
    'issues-status',
  );
  const cols = CONFIG.issues.columns;
  const rows = missing.map((d) => {
    const dealId = String(getField(d, CONFIG.secOps.dealIdField));
    return [
      ...cols.map((c) => String(getField(d, c.field) ?? '')),
      { text: 'Map…', onClick: () => startMapping(suggestMapping(dealId, mapEntries)) },
    ];
  });
  $('issues-result').replaceChildren(
    rows.length ? renderTable([...cols.map((c) => c.label), ''], rows) : el('p', 'No issues.'),
  );
}

$('issues-refresh').addEventListener('click', async () => {
  $('issues-refresh').disabled = true;
  try {
    await requestHostAccess();
    setStatus('Fetching deals from SecOps…', false, 'issues-status');
    lastDeals = { deals: await loadDeals(), fetchedAt: new Date() };
    renderIssues();
  } catch (e) {
    setStatus(e.message, true, 'issues-status');
  } finally {
    $('issues-refresh').disabled = false;
  }
});

// --- Mappings ---

// Save the map and refresh every view that depends on it.
async function commitMap(message) {
  await saveMap(mapEntries);
  renderBuild();
  renderIssues();
  renderIssuerList();
  setStatus(`${message} · ${mapEntries.length} mappings, saved.`, false, 'map-status');
}

function renderIssuerList() {
  const issuers = [...new Set(mapEntries.map((m) => m.issuer))].sort((a, b) => a.localeCompare(b));
  $('issuer-list').replaceChildren(
    ...issuers.map((i) => {
      const o = el('option');
      o.value = i;
      return o;
    }),
  );
}

function entryInput(entry, field) {
  const input = el('input');
  input.value = entry[field] ?? '';
  input.addEventListener('change', async () => {
    const value = input.value.trim();
    if (!value) {
      input.value = entry[field];
      setStatus('Mapping fields cannot be empty. Use ✕ to remove a row.', true, 'map-status');
      return;
    }
    // One deal per (issuer, series): refuse an edit that would duplicate another row's key,
    // since the join would silently use only one of them.
    if (field !== 'dealId') {
      const next = { ...entry, [field]: value };
      const key = mapKey(next.issuer, next.series);
      const clash = mapEntries.find((m) => m !== entry && mapKey(m.issuer, m.series) === key);
      if (clash) {
        input.value = entry[field];
        setStatus(
          `${next.issuer} ${next.series} is already mapped to ${clash.dealId}. Edit or remove that row instead.`,
          true,
          'map-status',
        );
        return;
      }
    }
    const before = entry[field];
    entry[field] = value;
    await commitMap(`Changed ${field} "${before}" → "${value}"`);
  });
  return input;
}

function renderMappings(flashEntry) {
  const terms = $('map-filter').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = mapEntries.filter((m) => {
    const text = `${m.issuer} ${m.series} ${m.dealId}`.toLowerCase();
    return terms.every((t) => text.includes(t));
  });

  const table = el('table');
  const headRow = table.createTHead().insertRow();
  ['Issuer', 'Series', 'SecOps deal', ''].forEach((h) => headRow.appendChild(el('th', h)));
  const body = table.createTBody();
  let flashRow;
  for (const entry of shown) {
    const tr = body.insertRow();
    for (const field of ['issuer', 'series', 'dealId']) tr.insertCell().appendChild(entryInput(entry, field));
    const remove = el('button', '✕');
    remove.className = 'link';
    remove.title = 'Remove this mapping';
    remove.addEventListener('click', async () => {
      mapEntries.splice(mapEntries.indexOf(entry), 1);
      renderMappings();
      await commitMap(`Removed ${entry.issuer} ${entry.series} → ${entry.dealId}`);
    });
    tr.insertCell().appendChild(remove);
    if (entry === flashEntry) flashRow = tr;
  }
  const wrap = el('div');
  wrap.className = 'scroll';
  wrap.appendChild(table);
  $('map-result').replaceChildren(
    el('p', `Showing ${shown.length} of ${mapEntries.length} mappings.`),
    wrap,
  );
  if (flashRow) {
    flashRow.classList.add('flash');
    flashRow.scrollIntoView({ block: 'center' });
  }
}

// Open the Mappings tab with the add form filled in, e.g. from an issue.
function startMapping({ issuer, series, dealId }) {
  showTab('mappings');
  $('map-add-issuer').value = issuer;
  $('map-add-series').value = series;
  $('map-add-deal').value = dealId;
  const empty = ['map-add-issuer', 'map-add-series', 'map-add-deal'].find((id) => !$(id).value);
  $(empty ?? 'map-add-deal').focus();
  setStatus('Check the mapping, then click Add.', false, 'map-status');
}

$('map-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const entry = {
    issuer: $('map-add-issuer').value.trim(),
    series: $('map-add-series').value.trim(),
    dealId: $('map-add-deal').value.trim(),
  };
  if (!entry.issuer || !entry.series || !entry.dealId) return;
  // One deal per (issuer, series): adding an existing key updates it instead.
  const existing = mapEntries.find((m) => mapKey(m.issuer, m.series) === mapKey(entry.issuer, entry.series));
  let message;
  if (existing) {
    message = `Updated ${existing.issuer} ${existing.series}: ${existing.dealId} → ${entry.dealId}`;
    existing.dealId = entry.dealId;
  } else {
    mapEntries.push(entry);
    message = `Added ${entry.issuer} ${entry.series} → ${entry.dealId}`;
  }
  $('map-add').reset();
  $('map-filter').value = '';
  renderMappings(existing ?? entry);
  await commitMap(message);
});

$('map-filter').addEventListener('input', () => renderMappings());

$('map-export').addEventListener('click', () => {
  // Same layout as data/deal-map.json: one entry per line.
  const json = `[\n${mapEntries.map((m) => '  ' + JSON.stringify(m)).join(',\n')}\n]\n`;
  const a = el('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = 'deal-map.json';
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('Exported. Replace data/deal-map.json with it to make these mappings the default.', false, 'map-status');
});

// Validate the whole file before anything replaces the current map: every entry needs
// non-empty text for issuer, series and dealId (a numeric dealId is allowed), and no two
// entries may share an (issuer, series) key.
function parseImportedMap(entries) {
  if (!Array.isArray(entries)) throw new Error('expected an array of {issuer, series, dealId}.');
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const seen = new Map();
  return entries.map((m, i) => {
    const entry = {
      issuer: text(m?.issuer),
      series: text(m?.series),
      dealId: typeof m?.dealId === 'number' ? String(m.dealId) : text(m?.dealId),
    };
    if (!entry.issuer || !entry.series || !entry.dealId) {
      throw new Error(`entry ${i + 1} needs non-empty issuer, series and dealId.`);
    }
    const key = mapKey(entry.issuer, entry.series);
    if (seen.has(key)) throw new Error(`entries ${seen.get(key) + 1} and ${i + 1} both map ${entry.issuer} ${entry.series}.`);
    seen.set(key, i);
    return entry;
  });
}

$('map-import').addEventListener('click', () => $('map-import-file').click());
$('map-import-file').addEventListener('change', async (e) => {
  const [file] = e.target.files;
  e.target.value = '';
  if (!file) return;
  try {
    mapEntries = parseImportedMap(JSON.parse(await file.text()));
    renderMappings();
    await commitMap(`Imported ${file.name}`);
  } catch (err) {
    setStatus(`Could not import ${file.name}: ${err.message}`, true, 'map-status');
  }
});

$('map-reset').addEventListener('click', async () => {
  if (!confirm('Discard all mapping edits and go back to data/deal-map.json?')) return;
  mapEntries = await resetMap();
  renderMappings();
  renderBuild();
  renderIssues();
  renderIssuerList();
  setStatus(`Reset to data/deal-map.json · ${mapEntries.length} mappings.`, false, 'map-status');
});

async function init() {
  mapEntries = await loadMap();
  renderMappings();
  renderIssuerList();
  setStatus(
    `${mapEntries.length} mappings · ` +
      ((await isEdited()) ? 'edited here (Export to save them to the repo).' : 'from data/deal-map.json.'),
    false,
    'map-status',
  );
}
init();

import { CONFIG } from './config.js';
import {
  downloadLink, extractTable, fetchFromSecOps, findStatements, followLink, loadInFrame, readForm, submitForm,
} from './injected.js';
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
      if (result) {
        return {
          tabId: tab.id,
          frameId: frame.frameId,
          listUrl: frame.url,
          dealForm: await readDealForm(tab.id, frame.frameId),
          rows: result.rows,
        };
      }
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

// The form Citi's deal links submit (CONFIG.citi.dealForm), copied from the table's frame,
// or null. Without it, opening a deal needs the table on screen.
async function readDealForm(tabId, frameId) {
  if (!CONFIG.citi.dealForm) return null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: readForm,
      args: [CONFIG.citi.dealForm.name],
    });
    if (!result) console.log(`Extendo: no form "${CONFIG.citi.dealForm.name}" next to Citi's table`);
    return result;
  } catch {
    return null;
  }
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
// `timeoutMs` passes. Returns each section found there with its files, or null.
async function waitForStatements(tabId, timeoutMs) {
  const labels = CONFIG.citi.statements.map((s) => s.label);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    for (const frame of frames) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          func: findStatements,
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

// How many of a section's newest files to download (null: all of them). Counts files the
// deal has, not calendar months.
const RANGES = [
  { label: 'Latest', count: 1 },
  { label: 'Last 3', count: 3 },
  { label: 'Last 6', count: 6 },
  { label: 'Last 12', count: 12 },
  { label: 'All', count: null },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = ({ year, month }) => `${MONTHS[month]} ${year}`;
const monthIndex = ({ year, month }) => year * 12 + month;

// Per-section choices from the last time the download question was answered Yes, saved in
// chrome.storage.local as {label: {checked, count}}. Until the first Yes, the sections
// marked `default: true` in config are ticked, all with Latest.
const PICKS_KEY = 'statementPicks';
async function loadPicks() {
  const { [PICKS_KEY]: saved } = await chrome.storage.local.get(PICKS_KEY);
  // Earlier versions saved an array of ticked labels (always the latest file).
  const entries = Array.isArray(saved)
    ? saved.map((label) => [label, { checked: true, count: 1 }])
    : Object.entries(saved ?? {});
  const picks = new Map(entries);
  if (!saved) {
    for (const s of CONFIG.citi.statements) if (s.default) picks.set(s.label, { checked: true, count: 1 });
  }
  return picks;
}

// Ask which of a deal's files to download: per configured section a checkbox, a range
// (RANGES) and the months it covers. A section whose newest file is older than the current
// month is flagged, since that month's file should normally be out. Sections the deal lacks
// are shown disabled. Resolves to [{label, checked, count, files}] for the sections offered
// (files: the ones in range), or null for No. A newer question (from another deal click)
// answers the pending one with No.
let answerPrompt = null;
function askWhichFiles(sections, picks) {
  answerPrompt?.(null);
  const now = new Date();
  const current = { year: now.getFullYear(), month: now.getMonth() };
  const choices = [];

  const update = () => {
    let total = 0;
    const staleTicked = [];
    for (const c of choices) {
      c.files = c.section.files.slice(0, c.count ?? undefined);
      const newest = c.files[0];
      const oldest = c.files[c.files.length - 1];
      c.detail.textContent =
        c.files.length === 1
          ? monthName(newest)
          : `${monthName(oldest)} – ${monthName(newest)} · ${c.files.length} files`;
      if (c.box.checked) {
        total += c.files.length;
        if (c.stale) staleTicked.push(c.section.label);
      }
    }
    $('prompt-text').textContent =
      total === 0 ? 'No files ticked.' : total === 1 ? 'Download this file?' : `Download these ${total} files?`;
    $('prompt-warning').textContent = staleTicked.length
      ? `No ${monthName(current)} file yet for: ${staleTicked.join(', ')}. The newest one there is older.`
      : '';
    $('prompt-warning').hidden = !staleTicked.length;
    $('prompt-yes').disabled = total === 0;
  };

  const items = CONFIG.citi.statements.map(({ label }) => {
    const li = el('li');
    const section = sections.find((s) => s.label === label);
    const box = el('input');
    box.type = 'checkbox';
    const name = el('label');
    name.append(box, label);
    if (!section) {
      box.disabled = true;
      li.className = 'unavailable';
      li.append(name, el('span', 'not on this deal'));
      return li;
    }

    const pick = picks.get(label) ?? { checked: false, count: 1 };
    box.checked = pick.checked;
    const range = el('select');
    RANGES.forEach((r, i) => {
      const option = el('option', r.label);
      option.value = String(i);
      option.selected = r.count === pick.count;
      range.appendChild(option);
    });
    const detail = el('span');
    detail.className = 'months';
    const choice = { section, box, detail, count: pick.count };
    choice.stale = monthIndex(section.files[0]) < monthIndex(current);

    li.append(name, range, detail);
    if (choice.stale) {
      li.classList.add('stale');
      const warning = el('span', `no ${monthName(current)} file yet`);
      warning.className = 'stale-note';
      li.appendChild(warning);
    }
    box.addEventListener('change', update);
    range.addEventListener('change', () => {
      choice.count = RANGES[+range.value].count;
      update();
    });
    choices.push(choice);
    return li;
  });

  $('prompt-list').replaceChildren(...items);
  update();
  $('prompt').hidden = false;
  return new Promise((resolve) => {
    answerPrompt = (yes) => {
      answerPrompt = null;
      $('prompt').hidden = true;
      resolve(
        yes
          ? choices.map((c) => ({ label: c.section.label, checked: c.box.checked, count: c.count, files: c.files }))
          : null,
      );
    };
  });
}
$('prompt-yes').addEventListener('click', () => answerPrompt?.(true));
$('prompt-no').addEventListener('click', () => answerPrompt?.(false));

const DOWNLOAD_GAP_MS = 500;

// The Citi operation in progress (a table build, or a deal opening or downloading), or null.
// While one is in progress, deal links and the Build buttons are disabled: each would move
// Citi's tab away from the page being read. A deal releases Citi while its download question
// is showing, so picking another deal (or building) then just answers the question No.
let citiOwner = null;
function claimCiti(op) {
  if (citiOwner && citiOwner !== op) return false;
  citiOwner = op;
  showCitiBusy();
  return true;
}
function releaseCiti(op) {
  if (citiOwner !== op) return;
  citiOwner = null;
  showCitiBusy();
}
function showCitiBusy() {
  const busy = citiOwner !== null;
  $('result').classList.toggle('citi-busy', busy);
  $('run').disabled = busy;
  $('run-no-secops').disabled = busy;
}

// Bumped by Stop downloads to end the download loop in progress.
let downloadRun = 0;
$('download-stop').addEventListener('click', () => {
  downloadRun++;
  $('download-stop').hidden = true;
});

// After a deal opens on Citi, offer the files of each report section on it to pick from.
// `op` holds Citi (claimCiti) until the question shows, and again while downloading.
async function offerStatements(tabId, op) {
  setStatus('Looking for reports…');
  const sections = await waitForStatements(tabId, 15000);
  if (!sections) {
    setStatus('Opened deal on Citi. No report sections found on it.');
    return;
  }
  console.log('Extendo: report sections', sections);
  if (!sections.length) {
    setStatus('Opened deal on Citi. Its report sections have no files.');
    return;
  }
  setStatus('Opened deal on Citi.');

  const picks = await loadPicks();
  releaseCiti(op);
  const choices = await askWhichFiles(sections, picks);
  // No, or another deal or build took over while the question was showing.
  if (!choices || !claimCiti(op)) return;
  // Remember the choices for the sections this deal offered; sections it lacked keep their
  // previous state, since they couldn't be changed here. Re-read first so a save made while
  // the question was showing isn't overwritten.
  const saved = await loadPicks();
  for (const { label, checked, count } of choices) saved.set(label, { checked, count });
  await chrome.storage.local.set({ [PICKS_KEY]: Object.fromEntries(saved) });

  const files = choices
    .filter((c) => c.checked)
    .flatMap((c) => c.files.map((f) => ({ ...f, title: `${monthName(f)} ${c.label}` })));
  const run = ++downloadRun;
  $('download-stop').hidden = false;
  const failed = [];
  let started = 0;
  for (const [i, file] of files.entries()) {
    // Space the downloads out; Chrome may drop clicks that arrive together.
    if (i > 0) await sleep(DOWNLOAD_GAP_MS);
    if (run !== downloadRun) break;
    setStatus(`Downloading ${i + 1} of ${files.length}: ${file.title}…`);
    if (await tryFollowLink(tabId, file.href, downloadLink)) started++;
    else failed.push(file.title);
  }
  const stopped = run !== downloadRun;
  $('download-stop').hidden = true;
  const summary = `Started ${started} of ${files.length} download${files.length === 1 ? '' : 's'}${stopped ? ' (stopped)' : ''}.`;
  setStatus(
    failed.length ? `${summary} Could not find these links anymore: ${failed.join(', ')}.` : summary,
    failed.length > 0,
  );
}

// Watches for frame `frameId` of `tabId` to start showing a new document. `committed`
// resolves true when it does, or false after `timeoutMs` or cancel(). Start watching before
// triggering the navigation so a fast one isn't missed.
function watchFrameCommit(tabId, frameId, timeoutMs) {
  let finish;
  const committed = new Promise((resolve) => {
    const listener = (d) => {
      if (d.tabId === tabId && d.frameId === frameId) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    finish = (ok) => {
      clearTimeout(timer);
      chrome.webNavigation.onCommitted.removeListener(listener);
      resolve(ok);
    };
    chrome.webNavigation.onCommitted.addListener(listener);
  });
  return { committed, cancel: () => finish(false) };
}

// Runs `func(...args)` in the frame that held Citi's table while watching it navigate.
// Returns true once the frame shows a new document (so nothing reads the page it left).
async function navigateTableFrame({ tabId, frameId }, func, args, timeoutMs) {
  const watch = watchFrameCommit(tabId, frameId, timeoutMs);
  let started = false;
  try {
    [{ result: started }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func,
      args,
    });
  } catch {
    // The frame is gone (Citi navigated away entirely) or not readable.
  }
  if (!started) {
    watch.cancel();
    return false;
  }
  return watch.committed;
}

// Open a deal by submitting Citi's deal form (copied at build time) with the deal's id, as
// its link would, in the frame that held the table. Works from any page in that frame, e.g.
// the previous deal's Reports page. The id comes only from `idFromLink` (digits).
async function submitDealForm(citiTable, href) {
  const spec = CONFIG.citi.dealForm;
  const id = spec && citiTable.dealForm && href.match(spec.idFromLink)?.[1];
  if (!id || !/^\d+$/.test(id)) return false;
  return navigateTableFrame(citiTable, submitForm, [citiTable.dealForm, { [spec.idField]: id }], 15000);
}

// Follow a link from Citi's table. If the table isn't showing (e.g. a previous click opened a
// deal), open the deal directly by submitting Citi's deal form. Failing that, reload the deal
// list in its frame and follow the link; as a last resort, go back in history.
const MAX_BACK_STEPS = 3;
async function openOnCiti(citiTable, href) {
  const { tabId } = citiTable;
  const op = {};
  if (!claimCiti(op)) return;
  answerPrompt?.(null);
  try {
    let opened = await tryFollowLink(tabId, href);
    if (!opened) {
      setStatus('Opening deal on Citi…');
      opened = await submitDealForm(citiTable, href);
      if (!opened) console.log('Extendo: could not open the deal by form; reloading the deal list');
    }
    if (!opened && citiTable.listUrl) {
      setStatus('Returning to the deal list on Citi…');
      opened =
        (await navigateTableFrame(citiTable, loadInFrame, [citiTable.listUrl], 15000)) &&
        (await waitAndFollowLink(tabId, href, 8000));
    }
    for (let step = 1; !opened && step <= MAX_BACK_STEPS; step++) {
      setStatus('Returning to the deal list on Citi…');
      await chrome.tabs.goBack(tabId);
      opened = await waitAndFollowLink(tabId, href, 8000);
    }
    if (!opened) throw new Error('could not find the deal list. Go back to it on Citi, then retry.');
    await chrome.tabs.update(tabId, { active: true });
    await offerStatements(tabId, op);
  } catch (e) {
    setStatus(`Could not open deal on Citi: ${e.message}`, true);
  } finally {
    releaseCiti(op);
  }
}

// Cells are strings, or {text, onClick, className?} for links.
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
        if (c.className) a.className = c.className;
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
      return href ? { text, onClick: () => openOnCiti(citiTable, href), className: 'deal-link' } : text;
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
  const op = {};
  if (!claimCiti(op)) return;
  answerPrompt?.(null);
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
    releaseCiti(op);
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

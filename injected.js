// Functions passed to chrome.scripting.executeScript are serialized and run inside the
// target page, so they must be self-contained: no imports, no references to module scope.

// Runs in every frame of Citi's tab. Returns the first table whose header row contains
// all of `requiredHeaders`, as an array of {header: cellText} objects, or null. Cells
// containing a link also record its href under row._links[header].
export function extractTable(requiredHeaders) {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const wanted = requiredHeaders.map((h) => clean(h).toLowerCase());

  for (const table of document.querySelectorAll('table')) {
    const headerRow = table.tHead?.rows[0] ?? table.rows[0];
    if (!headerRow) continue;
    const headers = [...headerRow.cells].map((c) => clean(c.innerText || c.textContent));
    const lower = headers.map((h) => h.toLowerCase());
    if (!wanted.every((w) => lower.includes(w))) continue;

    const rows = [...table.rows]
      .filter((r) => r !== headerRow && r.cells.length > 0)
      .map((r) => {
        const row = {};
        const links = {};
        headers.forEach((h, i) => {
          const cell = r.cells[i];
          row[h] = cell ? clean(cell.innerText || cell.textContent) : '';
          const href = cell?.querySelector('a[href]')?.getAttribute('href');
          if (href) links[h] = href;
        });
        if (Object.keys(links).length) row._links = links;
        return row;
      });
    return { frameUrl: location.href, headers, rows };
  }
  return null;
}

// Runs in Citi's MAIN world in one frame and follows a link from the table as clicking it
// would. Returns false (doing nothing) unless this frame currently shows that link, i.e.
// the table is still there. For `javascript:fn(args)` links (e.g. reqDl(2947)) it calls
// the page's own function; otherwise it clicks the anchor.
export function followLink(href) {
  const anchor = [...document.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === href);
  if (!anchor) return false;
  const m = href.match(/^javascript:\s*([\w$.]+)\((.*)\);?\s*$/);
  const fn = m && m[1].split('.').reduce((o, k) => o?.[k], window);
  if (typeof fn === 'function') {
    fn(...JSON.parse(`[${m[2].replace(/'/g, '"')}]`));
  } else {
    anchor.click();
  }
  return true;
}

// Runs in the frame showing Citi's deal table. Returns a copy of the form named `name`
// (where its links put the deal id before submitting it): {action, method, fields}, with
// fields as [name, value] pairs, or null if there's no such form. Reads attributes rather
// than form.action / form.method, which a field named "action" or "method" would shadow.
export function readForm(name) {
  const form = document.forms[name];
  if (!form) return null;
  return {
    action: new URL(form.getAttribute('action') ?? '', location.href).href,
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fields: [...new FormData(form)].filter(([, v]) => typeof v === 'string'),
  };
}

// Runs in the Citi frame that should show the next page (the one that held the deal table).
// Submits a copy of `form` (from readForm) with `values` replacing its fields, exactly as
// Citi's own link would, so the frame loads that deal without the table being on screen.
// Refuses (returns false) unless the frame is on the form's own origin.
export function submitForm(form, values) {
  if (new URL(form.action).origin !== location.origin) return false;
  const copy = document.createElement('form');
  copy.method = form.method;
  copy.action = form.action;
  copy.hidden = true;
  for (const [name, value] of form.fields) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = Object.hasOwn(values, name) ? values[name] : value;
    copy.appendChild(input);
  }
  (document.body ?? document.documentElement).appendChild(copy);
  copy.submit();
  return true;
}

// Runs in one Citi frame: loads `url` in it, if it's on the frame's own origin.
export function loadInFrame(url) {
  if (new URL(url).origin !== location.origin) return false;
  location.href = url;
  return true;
}

// Runs in each frame of Citi after a deal is opened (the deal's Reports page). For each of
// `labels` with at least one file, returns {label, files}: files are {href, year, month}
// (month 0-11), newest first. Returns null if the frame shows none of the headings (not the
// Reports page, or not loaded yet).
//
// The Reports page is one table split into sections: a heading row (a single wide cell,
// e.g. "Certificate Holders Statement"), then one row per year whose cells are month
// links ("Jan".."Dec") to the files. A section is the rows under its heading, up to the
// next heading. A heading matches its label exactly or followed by a bracketed note, e.g.
// "Enhanced Loan-Level Data (report legends)".
export function findStatements(labels) {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const isHeading = (tr) => tr.cells.length === 1 && tr.cells[0].colSpan > 1;
  const headings = [...document.querySelectorAll('tr')].filter(isHeading);

  let seenAny = false;
  const found = [];
  for (const label of labels) {
    const want = label.toLowerCase();
    const heading = headings.find((tr) => {
      const text = clean(tr.cells[0].textContent).toLowerCase();
      return text === want || text.startsWith(`${want} (`);
    });
    if (!heading) continue;
    seenAny = true;

    const files = [];
    for (let tr = heading.nextElementSibling; tr && !isHeading(tr); tr = tr.nextElementSibling) {
      const year = clean(tr.textContent).match(/\b(\d{4})\b/)?.[1];
      if (!year) continue;
      for (const a of tr.querySelectorAll('a[href]')) {
        const month = months.indexOf(clean(a.textContent).slice(0, 3).toLowerCase());
        if (month >= 0) files.push({ href: a.getAttribute('href'), year: +year, month });
      }
    }
    if (!files.length) continue;
    files.sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month));
    found.push({ label, files });
  }
  return seenAny ? found : null;
}

// Runs in Citi's MAIN world in one frame. Downloads the file behind a link the frame
// currently shows, instead of opening it in the frame. Returns false if the link is gone.
export function downloadLink(href) {
  const anchor = [...document.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === href);
  if (!anchor) return false;
  const temp = document.createElement('a');
  temp.href = anchor.href;
  temp.download = '';
  document.body.appendChild(temp);
  temp.click();
  temp.remove();
  return true;
}

// Runs in SecOps's MAIN world so the request carries SecOps's cookies exactly as the dashboard itself
// would, plus the Authorization header captured from the app's own requests (if any).
export async function fetchFromSecOps(apiUrl, authorization) {
  try {
    const headers = { Accept: 'application/json', forAudit: 'extendo' };
    if (authorization) headers.Authorization = authorization;
    const res = await fetch(apiUrl, { credentials: 'include', headers });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      return { error: `HTTP ${res.status} from SecOps: ${body}`, status: res.status };
    }
    return { data: await res.json() };
  } catch (e) {
    return { error: String(e) };
  }
}

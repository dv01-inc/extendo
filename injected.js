// Functions passed to chrome.scripting.executeScript are serialized and run inside the
// target page, so they must be self-contained: no imports, no references to module scope.

// Runs in every frame of citi's tab. Returns the first table whose header row contains
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

// Runs in citi's MAIN world in one frame and follows a link from the table as clicking it
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

// Runs in each frame of citi after a deal is opened (the deal's Reports page). Returns
// the most recent `label` statement as {title, href, candidates}, or null.
//
// The Reports page is one table split into sections: a heading row (a single wide cell,
// e.g. "Certificate Holders Statement"), then one row per year whose cells are month
// links ("Jan".."Dec") to the PDFs. We read only the rows under the matching heading,
// up to the next heading.
export function findLatestStatement(label) {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const isHeading = (tr) => tr.cells.length === 1 && tr.cells[0].colSpan > 1;

  const heading = [...document.querySelectorAll('tr')].find(
    (tr) => isHeading(tr) && clean(tr.cells[0].textContent).toLowerCase() === label.toLowerCase(),
  );
  if (!heading) return null;

  const candidates = [];
  for (let tr = heading.nextElementSibling; tr && !isHeading(tr); tr = tr.nextElementSibling) {
    const year = clean(tr.textContent).match(/\b(\d{4})\b/)?.[1];
    if (!year) continue;
    for (const a of tr.querySelectorAll('a[href]')) {
      const month = months.indexOf(clean(a.textContent).slice(0, 3).toLowerCase());
      if (month < 0) continue;
      candidates.push({
        title: `${clean(a.textContent)} ${year} ${label}`,
        href: a.getAttribute('href'),
        date: +year * 12 + month,
      });
    }
  }
  if (!candidates.length) return null;
  const latest = candidates.reduce((a, b) => (b.date > a.date ? b : a));
  return { title: latest.title, href: latest.href, candidates };
}

// Runs in citi's MAIN world in one frame. Downloads the file behind a link the frame
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

// Runs in SecOps's MAIN world so the request carries B's cookies exactly as B's own app
// would, plus the Authorization header captured from the app's own requests (if any).
export async function fetchFromB(apiUrl, authorization) {
  try {
    const headers = { Accept: 'application/json' };
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

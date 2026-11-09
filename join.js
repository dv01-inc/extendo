// Pure join logic, kept free of chrome.* so it can be tested with plain Node.

export const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

export const mapKey = (issuer, series) => `${normalize(issuer)}|${normalize(series)}`;

// Dotted-path lookup on B's deal objects, e.g. 'tranches.0.balance'.
export function getField(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Case-insensitive header lookup on A's rows.
export function getCell(row, header) {
  const want = header.toLowerCase();
  const key = Object.keys(row).find((k) => k.toLowerCase() === want);
  return key === undefined ? undefined : row[key];
}

export function joinRows({ rowsA, deals, mapEntries, issuerColumn, seriesColumn, dealIdField }) {
  const dealIdByKey = new Map(mapEntries.map((m) => [mapKey(m.issuer, m.series), String(m.dealId)]));
  const dealsById = new Map(deals.map((d) => [String(getField(d, dealIdField)), d]));

  const matched = [];
  const unmapped = [];
  const missingDeal = [];

  for (const row of rowsA) {
    const issuer = getCell(row, issuerColumn);
    const series = getCell(row, seriesColumn);
    const dealId = dealIdByKey.get(mapKey(issuer, series));
    if (dealId === undefined) {
      unmapped.push({ issuer, series });
      continue;
    }
    const deal = dealsById.get(dealId);
    if (!deal) {
      missingDeal.push({ issuer, series, dealId });
      continue;
    }
    matched.push({ a: row, b: deal });
  }
  return { matched, unmapped, missingDeal };
}

export function project({ a, b }, output) {
  return output.map((col) => {
    const v = col.value ? col.value(a, b) : col.from === 'a' ? getCell(a, col.field) : getField(b, col.field);
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// Deals that `include` accepts but that no map entry points to.
export function unmappedDeals({ deals, mapEntries, dealIdField, include }) {
  const mapped = new Set(mapEntries.map((m) => String(m.dealId)));
  return deals.filter((d) => include(d) && !mapped.has(String(getField(d, dealIdField))));
}

// Guess a map entry for a B deal id like 'SEMT 2020-1': the series is the last word, and
// the issuer is the one most often mapped to other deals with the same shelf ('SEMT').
export function suggestMapping(dealId, mapEntries) {
  const [shelf, series] = splitDealId(dealId);
  const counts = new Map();
  for (const m of mapEntries) {
    if (splitDealId(m.dealId)[0] !== shelf) continue;
    counts.set(m.issuer, (counts.get(m.issuer) ?? 0) + 1);
  }
  const [issuer = ''] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? [];
  return { issuer, series, dealId };
}

function splitDealId(dealId) {
  const s = String(dealId ?? '').replace(/\s+/g, ' ').trim();
  const i = s.lastIndexOf(' ');
  return i < 0 ? ['', s] : [normalize(s.slice(0, i)), s.slice(i + 1)];
}

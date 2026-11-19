// Checks data/deal-map.json, the bundled seed map. Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapKey, joinRows, unmappedDeals } from '../join.js';

const root = new URL('../', import.meta.url);
const text = readFileSync(new URL('data/deal-map.json', root), 'utf8');
const map = JSON.parse(text);

test('is an array of { issuer, series, dealId } with non-empty strings', () => {
  assert.ok(Array.isArray(map) && map.length > 0);
  map.forEach((e, i) => {
    assert.deepEqual(Object.keys(e).sort(), ['dealId', 'issuer', 'series'], `entry ${i}: ${JSON.stringify(e)}`);
    for (const k of ['issuer', 'series', 'dealId']) {
      assert.ok(typeof e[k] === 'string' && e[k].trim(), `entry ${i} has an empty ${k}: ${JSON.stringify(e)}`);
    }
  });
});

test('has no two entries for the same (issuer, series), ignoring case and spacing', () => {
  // The Mappings tab and Import treat the key as unique; a duplicate here would mean the
  // later entry silently wins in joinRows.
  const seen = new Map();
  const dups = [];
  map.forEach((e, i) => {
    const k = mapKey(e.issuer, e.series);
    if (seen.has(k)) dups.push(`lines ${seen.get(k) + 2} and ${i + 2}: ${e.issuer} / ${e.series}`);
    else seen.set(k, i);
  });
  assert.deepEqual(dups, []);
});

test('keeps the one-entry-per-line format that Export writes', () => {
  // Keeps diffs reviewable: one added/changed mapping = one changed line.
  const lines = text.trimEnd().split('\n');
  assert.equal(lines[0], '[');
  assert.equal(lines.at(-1), ']');
  const body = lines.slice(1, -1);
  assert.equal(body.length, map.length, 'each entry should be on its own line');
  body.forEach((line, i) => {
    const entry = JSON.parse(line.replace(/,\s*$/, ''));
    assert.deepEqual(entry, map[i], `line ${i + 2}`);
    assert.equal(line.trimEnd().endsWith(','), i < body.length - 1, `line ${i + 2}: comma`);
  });
});

test('every entry joins against a Citi row with the same issuer and series', () => {
  // Sanity check that join.js and the map agree: feed the map back in as Citi rows.
  const citiRows = map.map((e) => ({ Issuer: e.issuer, Series: e.series }));
  const r = joinRows({ citiRows, deals: null, mapEntries: map, issuerColumn: 'Issuer', seriesColumn: 'Series', dealIdField: 'dealName' });
  assert.equal(r.matched.length, map.length);
  assert.equal(r.unmapped.length, 0);
});

test('against the deals.json snapshot, Issues lists only unmapped Citi deals', () => {
  const raw = JSON.parse(readFileSync(new URL('deals.json', root), 'utf8'));
  const deals = Array.isArray(raw) ? raw : Object.values(raw).find(Array.isArray);
  const include = (d) => d.trustee === 'Citi';
  const mapped = new Set(map.map((e) => e.dealId));
  const issues = unmappedDeals({ deals, mapEntries: map, dealIdField: 'dealName', include });
  for (const d of issues) {
    assert.equal(d.trustee, 'Citi');
    assert.ok(!mapped.has(d.dealName));
  }
  // Every Citi deal is either an issue or mapped: nothing falls through the cracks.
  const citiDeals = deals.filter(include);
  assert.equal(issues.length + citiDeals.filter((d) => mapped.has(d.dealName)).length, citiDeals.length);
});

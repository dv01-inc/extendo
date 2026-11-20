// Unit tests for join.js. Run with: node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, mapKey, getField, getCell, joinRows, project, unmappedDeals, suggestMapping,
} from '../join.js';

const cols = { issuerColumn: 'Issuer', seriesColumn: 'Series', dealIdField: 'dealName' };
const citiRow = (issuer, series, extra = {}) => ({ Issuer: issuer, Series: series, ...extra });

describe('normalize / mapKey', () => {
  test('ignores case and collapses whitespace, including tabs and non-breaking spaces', () => {
    assert.equal(normalize('  colt\t mortgage trust '), 'COLT MORTGAGE TRUST');
  });

  test('treats null and undefined as empty, and stringifies numbers', () => {
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
    assert.equal(normalize(2022), '2022');
  });

  test('keys that differ only by case or spacing are equal', () => {
    assert.equal(mapKey(' colt ', '2022-2'), mapKey('COLT', ' 2022-2'));
    assert.notEqual(mapKey('COLT', '2022-2'), mapKey('COLT', '2022-3'));
  });

  test('the separator keeps issuer and series apart', () => {
    assert.notEqual(mapKey('A B', 'C'), mapKey('A', 'B C'));
  });
});

describe('getField / getCell', () => {
  test('getField follows dotted paths and stops safely at missing links', () => {
    const deal = { a: { b: [{ c: 5 }] } };
    assert.equal(getField(deal, 'a.b.0.c'), 5);
    assert.equal(getField(deal, 'a.x.y'), undefined);
    assert.equal(getField(deal, ''), deal);
  });

  test('getCell matches headers case-insensitively', () => {
    assert.equal(getCell({ ISSUER: 'X' }, 'issuer'), 'X');
    assert.equal(getCell({ Issuer: 'X' }, 'Series'), undefined);
  });
});

describe('joinRows with SecOps deals', () => {
  const mapEntries = [
    { issuer: 'COLT', series: '2022-2', dealId: 'COLT 2022-2' },
    { issuer: 'GCAT Trust', series: '2024-INV1', dealId: 'GCAT 2024-INV1' },
  ];
  const deals = [{ dealName: 'COLT 2022-2', trustee: 'Citi' }];

  const result = joinRows({
    ...cols,
    citiRows: [
      citiRow('  colt ', '2022-2'),        // mapped despite case/whitespace
      citiRow('GCAT Trust', '2024-INV1'),  // mapped, but SecOps didn't return it
      citiRow('Example Trust', '2026-1'),  // not in the map
    ],
    deals,
    mapEntries,
  });

  test('puts each Citi row in exactly one bucket', () => {
    assert.equal(result.matched.length, 1);
    assert.equal(result.missingDeal.length, 1);
    assert.equal(result.unmapped.length, 1);
  });

  test('matched rows pair the Citi row with its SecOps deal', () => {
    assert.equal(result.matched[0].citi.Issuer, '  colt ');
    assert.equal(result.matched[0].secOps, deals[0]);
    assert.equal(result.matched[0].noSecOps, undefined);
  });

  test('missingDeal and unmapped rows keep the Citi issuer and series', () => {
    assert.deepEqual(result.missingDeal[0], { issuer: 'GCAT Trust', series: '2024-INV1', dealId: 'GCAT 2024-INV1' });
    assert.deepEqual(result.unmapped[0], { issuer: 'Example Trust', series: '2026-1' });
  });

  test('deal ids match SecOps exactly (case matters), but as strings', () => {
    const r = joinRows({
      ...cols,
      citiRows: [citiRow('A', '1'), citiRow('B', '2')],
      deals: [{ dealName: 'colt 2022-2' }, { dealName: 42 }],
      mapEntries: [
        { issuer: 'A', series: '1', dealId: 'COLT 2022-2' },
        { issuer: 'B', series: '2', dealId: '42' },
      ],
    });
    assert.deepEqual(r.missingDeal.map((m) => m.dealId), ['COLT 2022-2']);
    assert.equal(r.matched.length, 1);
    assert.equal(r.matched[0].secOps.dealName, 42);
  });

  test('reads the Issuer and Series headers case-insensitively', () => {
    const r = joinRows({ ...cols, citiRows: [{ ISSUER: 'COLT', series: '2022-2' }], deals, mapEntries });
    assert.equal(r.matched.length, 1);
  });

  test('a later map entry with the same key wins', () => {
    const r = joinRows({
      ...cols,
      citiRows: [citiRow('COLT', '2022-2')],
      deals: [{ dealName: 'OLD' }, { dealName: 'NEW' }],
      mapEntries: [
        { issuer: 'COLT', series: '2022-2', dealId: 'OLD' },
        { issuer: 'colt', series: '2022-2', dealId: 'NEW' },
      ],
    });
    assert.equal(r.matched[0].secOps.dealName, 'NEW');
  });
});

describe('joinRows without SecOps (deals: null)', () => {
  const mapEntries = [{ issuer: 'COLT', series: '2022-2', dealId: 'COLT 2022-2' }];

  test('every mapped row matches a stand-in deal flagged noSecOps', () => {
    const r = joinRows({ ...cols, citiRows: [citiRow('colt', '2022-2'), citiRow('X', '1')], deals: null, mapEntries });
    assert.equal(r.matched.length, 1);
    assert.deepEqual(r.matched[0].secOps, { dealName: 'COLT 2022-2' });
    assert.equal(r.matched[0].noSecOps, true);
    assert.equal(r.unmapped.length, 1);
    assert.equal(r.missingDeal.length, 0);
  });

  test('the stand-in deal follows a dotted dealIdField', () => {
    const r = joinRows({ ...cols, dealIdField: 'deal.name', citiRows: [citiRow('COLT', '2022-2')], deals: null, mapEntries });
    assert.deepEqual(r.matched[0].secOps, { deal: { name: 'COLT 2022-2' } });
    assert.equal(getField(r.matched[0].secOps, 'deal.name'), 'COLT 2022-2');
  });
});

describe('project', () => {
  const output = [
    { label: 'Waiting', value: (row, deal) => deal.status === 'Waiting', noSecOps: 'Unknown' },
    { label: 'Issuer', from: 'citi', field: 'issuer' },
    { label: 'Deal', from: 'secOps', field: 'info.name' },
    { label: 'Missing', from: 'secOps', field: 'nope' },
    { label: 'Obj', from: 'secOps', field: 'info' },
  ];
  const citi = citiRow('COLT', '2022-2');
  const secOps = { status: 'Waiting', info: { name: 'COLT 2022-2' } };

  test('reads Citi headers, SecOps dotted fields and computed values as strings', () => {
    assert.deepEqual(project({ citi, secOps }, output), [
      'true', 'COLT', 'COLT 2022-2', '', '{"name":"COLT 2022-2"}',
    ]);
  });

  test('uses noSecOps values only for rows joined without SecOps', () => {
    const row = { citi, secOps: { info: { name: 'COLT 2022-2' } }, noSecOps: true };
    assert.deepEqual(project(row, output).slice(0, 3), ['Unknown', 'COLT', 'COLT 2022-2']);
  });

  test('a falsy noSecOps value is still used', () => {
    const cols2 = [{ label: 'x', value: () => 'computed', noSecOps: '' }];
    assert.deepEqual(project({ citi, secOps: {}, noSecOps: true }, cols2), ['']);
  });
});

describe('unmappedDeals', () => {
  const deals = [
    { dealName: 'COLT 2022-2', trustee: 'Citi' },
    { dealName: 'COLT 2026-9', trustee: 'Citi' },
    { dealName: 'Avant Platform', trustee: 'Wilmington' },
  ];
  const include = (d) => d.trustee === 'Citi';

  test('returns included deals that no map entry points to', () => {
    const r = unmappedDeals({ deals, mapEntries: [{ issuer: 'COLT', series: '2022-2', dealId: 'COLT 2022-2' }], dealIdField: 'dealName', include });
    assert.deepEqual(r.map((d) => d.dealName), ['COLT 2026-9']);
  });

  test('uses the same exact id rule as joinRows, so "not an issue" means "will join"', () => {
    const r = unmappedDeals({ deals, mapEntries: [{ issuer: 'COLT', series: '2022-2', dealId: 'colt 2022-2' }], dealIdField: 'dealName', include });
    assert.deepEqual(r.map((d) => d.dealName), ['COLT 2022-2', 'COLT 2026-9']);
  });
});

describe('suggestMapping', () => {
  const mapEntries = [
    { issuer: 'COLT Mortgage Loan Trust', series: '2022-2', dealId: 'COLT 2022-2' },
    { issuer: 'COLT Mortgage Loan Trust', series: '2023-1', dealId: 'COLT 2023-1' },
    { issuer: 'COLT Trust', series: '2021-1', dealId: 'colt 2021-1' },
    { issuer: 'Sequoia Mortgage Trust', series: '2020-1', dealId: 'SEMT 2020-1' },
  ];

  test('series is the last word and issuer is the most common one on the shelf', () => {
    assert.deepEqual(suggestMapping('COLT 2026-9', mapEntries), {
      issuer: 'COLT Mortgage Loan Trust', series: '2026-9', dealId: 'COLT 2026-9',
    });
  });

  test('handles multi-word shelves and extra whitespace', () => {
    const entries = [{ issuer: 'Big Shelf Trust', series: '1', dealId: 'BIG SHELF 2020-1' }];
    assert.equal(suggestMapping('  big  shelf 2026-1 ', entries).issuer, 'Big Shelf Trust');
    assert.equal(suggestMapping('  big  shelf 2026-1 ', entries).series, '2026-1');
  });

  test('leaves the issuer blank for an unknown shelf', () => {
    assert.deepEqual(suggestMapping('EXMT 2026-1', mapEntries), { issuer: '', series: '2026-1', dealId: 'EXMT 2026-1' });
  });

  test('a one-word id is all series and gets no issuer', () => {
    assert.deepEqual(suggestMapping('2026-1', mapEntries), { issuer: '', series: '2026-1', dealId: '2026-1' });
  });
});

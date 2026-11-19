// Checks the rules CLAUDE.md says must hold between config.js, manifest.json and the
// release workflow. Run with: node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { project } from '../join.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const configSource = read('config.js');
const manifest = JSON.parse(read('manifest.json'));

// Imports config.js with its mock switches forced to the given values, so both the real
// and the mock URLs can be checked whatever the working copy has.
async function loadConfig({ citi, secOps }) {
  const source = configSource
    .replace(/^const MOCK_CITI = \w+;/m, `const MOCK_CITI = ${citi};`)
    .replace(/^const MOCK_SECOPS = \w+;/m, `const MOCK_SECOPS = ${secOps};`);
  const { CONFIG } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  return CONFIG;
}

// Chrome match pattern -> RegExp. A pattern without a port matches any port.
function patternToRegExp(pattern) {
  const m = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
  assert.ok(m, `not a match pattern: ${pattern}`);
  const [, scheme, host, path] = m;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const schemeRe = scheme === '*' ? 'https?' : scheme;
  let hostRe = host === '*' ? '[^/]+' : esc(host).replace(/^\\\*\\\./, '(?:[^/]+\\.)?').replace(/^\*\\\./, '(?:[^/]+\\.)?');
  if (!/:\d+$/.test(host) && host !== '*') hostRe += '(?::\\d+)?';
  const pathRe = esc(path).replace(/\*/g, '.*');
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

const permitted = (url) => manifest.host_permissions.some((p) => patternToRegExp(p).test(url));
// A URL that a urlMatch pattern would match, e.g. 'https://sf.citidirect.com/*' -> '.../x'.
const sampleUrl = (pattern) => pattern.replace(/\*/g, 'x');

describe('mock switches', () => {
  test('config.js still defines MOCK_CITI and MOCK_SECOPS (the release guard greps for them)', () => {
    assert.match(configSource, /^const MOCK_CITI = (true|false);$/m);
    assert.match(configSource, /^const MOCK_SECOPS = (true|false);$/m);
  });

  // Fails in CI; skipped locally so the other tests still run while you test against mocks.
  test('no MOCK_* switch is committed as true', (t) => {
    const on = configSource.match(/^const MOCK_[A-Z_]+ = true/gm) ?? [];
    if (on.length && !process.env.CI) {
      t.skip(`${on.join(', ')} (fine locally; set to false before committing)`);
      return;
    }
    assert.deepEqual(on, [], 'set every MOCK_* switch in config.js to false before committing');
  });
});

describe('host_permissions cover every URL config.js uses', () => {
  for (const citi of [false, true]) {
    for (const secOps of [false, true]) {
      test(`MOCK_CITI=${citi}, MOCK_SECOPS=${secOps}`, async () => {
        const CONFIG = await loadConfig({ citi, secOps });
        for (const url of [sampleUrl(CONFIG.citi.urlMatch), sampleUrl(CONFIG.secOps.urlMatch), CONFIG.secOps.apiUrl]) {
          assert.ok(permitted(url), `${url} is not covered by manifest.json host_permissions`);
        }
      });
    }
  }

  test("the mock Citi iframe origin (127.0.0.1:8765, not localhost) is permitted", () => {
    assert.ok(permitted('http://127.0.0.1:8765/frame/deals'));
  });

  test('the real sites stay permitted after release strips the mock hosts', () => {
    // Same filter as the "Build release zip" step in .github/workflows/release.yml.
    const released = manifest.host_permissions.filter((p) => !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(p));
    assert.ok(released.length > 0);
    for (const p of released) assert.ok(p.startsWith('https://'), `release would keep ${p}`);
    assert.ok(released.some((p) => patternToRegExp(p).test('https://sf.citidirect.com/x')));
    assert.ok(released.some((p) => patternToRegExp(p).test('https://secops-dashboard.dv01.cloud/v1/deals')));
  });

  test('patternToRegExp itself behaves', () => {
    assert.ok(patternToRegExp('http://localhost:8765/*').test('http://localhost:8765/a'));
    assert.ok(!patternToRegExp('http://localhost:8765/*').test('http://127.0.0.1:8765/a'));
    assert.ok(!patternToRegExp('http://localhost:8765/*').test('http://localhost:8766/a'));
    assert.ok(patternToRegExp('https://*.example.com/*').test('https://a.example.com/x'));
  });
});

describe('manifest.json is the dev build', () => {
  test('name and version_name mark it as dev', () => {
    assert.equal(manifest.name, 'Extendo (dev)');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.version_name, `${manifest.version}-dev`);
  });
});

describe('CONFIG contents', async () => {
  const CONFIG = await loadConfig({ citi: false, secOps: false });

  test('statement sections are unique and at least one is ticked by default', () => {
    const labels = CONFIG.citi.statements.map((s) => s.label);
    assert.equal(new Set(labels.map((l) => l.toLowerCase())).size, labels.length, 'duplicate section label');
    assert.ok(CONFIG.citi.statements.some((s) => s.default), 'no section has default: true');
  });

  test('every output column says where its value comes from', () => {
    for (const col of CONFIG.output) {
      assert.ok(col.label, 'column without a label');
      if (col.value) assert.equal(typeof col.value, 'function', `${col.label}: value must be a function`);
      else assert.ok(['citi', 'secOps'].includes(col.from), `${col.label}: from must be 'citi' or 'secOps' (exact case)`);
      if (col.from) assert.ok(col.field, `${col.label}: from without field`);
      if (col.sort) assert.ok(['asc', 'desc'].includes(col.sort), `${col.label}: bad sort`);
    }
  });

  test('SecOps-derived columns say what to show without SecOps', () => {
    // A no-SecOps build only knows the deal id, so other SecOps columns need `noSecOps`.
    for (const col of CONFIG.output) {
      const fromSecOps = col.value || col.from === 'secOps';
      const isDealId = col.from === 'secOps' && col.field === CONFIG.secOps.dealIdField;
      if (fromSecOps && !isDealId) {
        assert.ok(col.noSecOps !== undefined, `${col.label}: add a noSecOps value`);
      }
    }
  });

  test('"Not Yet Available in GCP" is true for Waiting (any case) and Unknown without SecOps', () => {
    const i = CONFIG.output.findIndex((c) => c.label === 'Not Yet Available in GCP');
    assert.ok(i >= 0);
    const citi = { Issuer: 'COLT', Series: '2022-2' };
    const cell = (row) => project(row, CONFIG.output)[i];
    assert.equal(cell({ citi, secOps: { trusteeReportReceived: { status: 'waiting' } } }), 'true');
    assert.equal(cell({ citi, secOps: { trusteeReportReceived: { status: 'Success' } } }), 'false');
    assert.equal(cell({ citi, secOps: {} }), 'false');
    assert.equal(cell({ citi, secOps: { dealName: 'COLT 2022-2' }, noSecOps: true }), 'Unknown');
  });

  test('Issues include only Citi deals', () => {
    assert.equal(CONFIG.issues.include({ trustee: 'Citi' }), true);
    assert.equal(CONFIG.issues.include({ trustee: 'Wilmington' }), false);
    assert.equal(CONFIG.issues.include({}), false);
  });
});

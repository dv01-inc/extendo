// Everything page-specific lives here. URL patterns used below must also be listed in
// manifest.json `host_permissions` (including the origin of Citi's iframe).

// true: use the local mock from dev/mock-server.py instead of the real site. Each site
// switches separately, e.g. mock Citi against the real SecOps.
// Never commit either as true; the release workflow refuses to ship it.
const MOCK_CITI = false;
const MOCK_SECOPS = false;

export const CONFIG = {
  mock: { citi: MOCK_CITI, secOps: MOCK_SECOPS },

  citi: {
    // Tab the user has open with the source table. The active matching tab wins.
    urlMatch: MOCK_CITI ? 'http://localhost:8765/*' : 'https://sf.citidirect.com/*',
    // Header text of the join columns in Citi's table (matched case-insensitively). The
    // first <table> in any frame that has both headers is used.
    issuerColumn: 'Issuer',
    seriesColumn: 'Series',
    // How Citi opens a deal: its link `javascript:reqDl(<id>)` puts the id into the deal
    // list's form `listform` (field `deal_id`) and POSTs it. Extendo copies that form when
    // the table is built, so it can open another deal from wherever Citi is (e.g. a deal's
    // Reports page) without going back to the list first. `idFromLink` must capture only
    // the id (digits), never anything else from the page.
    dealForm: {
      name: 'listform',
      idField: 'deal_id',
      idFromLink: /^javascript:\s*reqDl\((\d+)\);?\s*$/,
    },
    // Report sections on a deal's Reports page. After a deal is opened, each section it has
    // is offered for download with a checkbox and a range (Latest, Last 3/6/12, All). The
    // choices from the last download are remembered; before the first one, `default: true`
    // sections start ticked with Latest.
    statements: [
      { label: 'Bond Factor Information' },
      { label: 'Performance Loan Details' },
      { label: 'EU Risk Retention Reporting' },
      { label: 'Certificate Holders Statement', default: true },
      { label: 'Enhanced Loan-Level Data' },
      { label: 'Supplemental Loan-Level Data' },
      { label: 'Notice to Investors' },
    ],
  },

  secOps: {
    // Tab where the user is logged into SecOps. The API call runs inside this tab, so it
    // uses SecOps's own session cookies and is same-origin.
    urlMatch: MOCK_SECOPS ? 'http://localhost:8766/*' : 'https://secops-dashboard.dv01.cloud/*',
    apiUrl: MOCK_SECOPS ? 'http://localhost:8766/v1/deals' : 'https://secops-dashboard.dv01.cloud/v1/deals',
    // Dotted path to the deals array in the response. '' means the response is the array,
    // or an object whose first array-valued property holds the deals.
    dealsPath: '',
    // Field on each deal that matches `dealId` in data/deal-map.json.
    dealIdField: 'dealName',
  },

  // Issues tab: SecOps deals that `include` accepts but that no deal map entry points to.
  // `columns` are (dotted) fields of the deal shown alongside it.
  issues: {
    include: (deal) => deal.trustee === 'Citi',
    columns: [
      { label: 'Deal', field: 'dealName' },
      { label: 'Platform', field: 'platform' },
      { label: 'Asset class', field: 'assetClass' },
    ],
  },

  // Columns shown in the side panel. `from: 'citi'` reads a header from Citi's table;
  // `from: 'secOps'` reads a (dotted) field from the matched deal. `value: (citiRow, deal) => …`
  // computes the cell instead. `linkFrom: '<Citi header>'` makes the cell a link that
  // follows that Citi cell's link on Citi. `sort: 'desc' | 'asc'` sorts the table by that
  // column (for booleans, 'desc' puts true first). `noSecOps: '…'` is shown instead when the
  // table was built without SecOps ("Build table (no SecOps)"); columns without it show
  // what they can (the deal id is still known from the deal map) or blank.
  output: [
    // SecOps reports 'Waiting' / 'Success'; compare case-insensitively.
    {
      label: 'Not Yet Available (GCP or Revver)',
      value: (citiRow, deal) => deal.trusteeReportReceived?.status?.toLowerCase() === 'waiting' ||
                                deal.trusteeReportRecordRevver?.status?.toLowerCase() === 'waiting',
      sort: 'desc',
      noSecOps: 'Unknown',
    },
    { label: 'Issuer', from: 'citi', field: 'Issuer' },
    { label: 'Series', from: 'citi', field: 'Series' },
    { label: 'Deal', from: 'secOps', field: 'dealName', linkFrom: 'Series' },
  ],
};

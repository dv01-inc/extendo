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
    // After a deal is opened, offer to download its most recent statement of this type.
    statementLabel: 'Certificate Holders Statement',
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
  // column (for booleans, 'desc' puts true first).
  output: [
    // SecOps reports 'Waiting' / 'Success'; compare case-insensitively.
    {
      label: 'Not Yet Available in GCP',
      value: (citiRow, deal) => deal.trusteeReportReceived?.status?.toLowerCase() === 'waiting',
      sort: 'desc',
    },
    { label: 'Issuer', from: 'citi', field: 'Issuer' },
    { label: 'Series', from: 'citi', field: 'Series' },
    { label: 'Deal', from: 'secOps', field: 'dealName', linkFrom: 'Series' },
  ],
};

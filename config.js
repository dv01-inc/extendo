// Everything page-specific lives here. URL patterns used below must also be listed in
// manifest.json `host_permissions` (including the origin of citi's iframe).
export const CONFIG = {
  pageA: {
    // Tab the user has open with the source table. The active matching tab wins.
    urlMatch: 'https://sf.citidirect.com/*',
    // Header text of the join columns in A's table (matched case-insensitively). The
    // first <table> in any frame that has both headers is used.
    issuerColumn: 'Issuer',
    seriesColumn: 'Series',
    // After a deal is opened, offer to download its most recent statement of this type.
    statementLabel: 'Certificate Holders Statement',
  },

  pageB: {
    // Tab where the user is logged into B. The API call runs inside this tab, so it
    // uses B's own session cookies and is same-origin.
    urlMatch: 'https://secops-dashboard.dv01.cloud/*',
    apiUrl: 'https://secops-dashboard.dv01.cloud/v1/deals',
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

  // Columns shown in the side panel. `from: 'a'` reads a header from A's table;
  // `from: 'b'` reads a (dotted) field from the matched deal. `value: (rowA, deal) => …`
  // computes the cell instead. `linkFrom: '<A header>'` makes the cell a link that
  // follows that A cell's link on citi. `sort: 'desc' | 'asc'` sorts the table by that
  // column (for booleans, 'desc' puts true first).
  output: [
    // SecOps reports 'Waiting' / 'Success'; compare case-insensitively.
    {
      label: 'Not Yet Available in GCP',
      value: (a, b) => b.trusteeReportReceived?.status?.toLowerCase() === 'waiting',
      sort: 'desc',
    },
    { label: 'Issuer', from: 'a', field: 'Issuer' },
    { label: 'Series', from: 'a', field: 'Series' },
    { label: 'Deal', from: 'b', field: 'dealName', linkFrom: 'Series' },
  ],
};

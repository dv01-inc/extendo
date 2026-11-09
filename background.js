import { CONFIG } from './config.js';

// Clicking the toolbar icon opens the side panel; the build itself happens in sidepanel.js.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// The repo's manifest is the dev build (version_name "x.y.z-dev"); release zips drop the
// suffix. Badge the toolbar icon so a dev copy is never mistaken for a release.
if (chrome.runtime.getManifest().version_name?.endsWith('-dev')) {
  chrome.action.setBadgeText({ text: 'DEV' });
  chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
}

// SecOps's dashboard authenticates its API calls with an Authorization header it keeps in
// memory. Copy it from the dashboard's own requests so the side panel can replay it.
// Session storage is memory-only and is cleared when the browser or extension restarts.
//
// The token is tied to the tab it came from and dropped as soon as that login may be over:
// the tab closes, navigates away from SecOps (e.g. logout to the sign-in page), or SecOps
// answers with 401. So an old login is never replayed for a new one.
const SECOPS_ORIGIN = new URL(CONFIG.pageB.apiUrl).origin;
let lastAuth;

async function clearAuthFor(tabId) {
  const { pageBAuth } = await chrome.storage.session.get('pageBAuth');
  if (!pageBAuth || (tabId !== undefined && pageBAuth.tabId !== tabId)) return;
  lastAuth = undefined;
  await chrome.storage.session.remove('pageBAuth');
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // tabId -1 is a request from the extension itself (the direct fallback), not the dashboard.
    if (details.tabId < 0) return;
    const auth = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'authorization')?.value;
    if (!auth || auth === lastAuth) return;
    lastAuth = auth;
    chrome.storage.session.set({ pageBAuth: { value: auth, tabId: details.tabId, capturedAt: Date.now() } });
  },
  { urls: [`${SECOPS_ORIGIN}/*`] },
  ['requestHeaders'],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    // 401 only: a 403 means the login is fine but lacks access to that one resource.
    if (details.statusCode === 401) clearAuthFor(details.tabId < 0 ? undefined : details.tabId);
  },
  { urls: [`${SECOPS_ORIGIN}/*`] },
);

chrome.tabs.onRemoved.addListener((tabId) => clearAuthFor(tabId));

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && !details.url.startsWith(`${SECOPS_ORIGIN}/`)) clearAuthFor(details.tabId);
});

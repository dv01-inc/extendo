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
let lastAuth;
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const auth = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'authorization')?.value;
    if (!auth || auth === lastAuth) return;
    lastAuth = auth;
    chrome.storage.session.set({ pageBAuth: { value: auth, capturedAt: Date.now() } });
  },
  { urls: [`${new URL(CONFIG.pageB.apiUrl).origin}/*`] },
  ['requestHeaders'],
);

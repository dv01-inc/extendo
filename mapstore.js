// The deal map lives in chrome.storage.local so the Mappings tab can edit it.
// data/deal-map.json is only the starting point, used until the first save or after a reset.
const KEY = 'dealMap';

export async function loadBundledMap() {
  const res = await fetch(chrome.runtime.getURL('data/deal-map.json'));
  return res.json();
}

export async function loadMap() {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  return stored ?? loadBundledMap();
}

export async function saveMap(entries) {
  await chrome.storage.local.set({ [KEY]: entries });
}

export async function resetMap() {
  await chrome.storage.local.remove(KEY);
  return loadBundledMap();
}

export async function isEdited() {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  return stored !== undefined;
}

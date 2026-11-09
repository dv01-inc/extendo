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

// Writes run one at a time in call order, so a save that started before a reset can't
// land after it and bring the discarded edits back.
let writes = Promise.resolve();
function queueWrite(fn) {
  const result = writes.then(fn);
  writes = result.catch(() => {});
  return result;
}

export function saveMap(entries) {
  // Snapshot now: the caller may keep mutating the array while this waits its turn.
  const snapshot = entries.map((m) => ({ ...m }));
  return queueWrite(() => chrome.storage.local.set({ [KEY]: snapshot }));
}

export async function resetMap() {
  await queueWrite(() => chrome.storage.local.remove(KEY));
  return loadBundledMap();
}

export async function isEdited() {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  return stored !== undefined;
}

// Speicherung: Einstellungen in localStorage, große Dinge (Fotos, Motive) in IndexedDB.

const KEY = 'scribit-mobile-v1';

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
}

export function saveSettings(obj) {
  try { localStorage.setItem(KEY, JSON.stringify(obj)); return true; } catch (e) { return false; }
}

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    try {
      const r = indexedDB.open('scribit-mobile', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
  return dbp;
}

export async function putBlob(key, value) {
  try {
    const d = await db();
    await new Promise((res, rej) => {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch (e) { return false; }
}

export async function getBlob(key) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const tx = d.transaction('kv', 'readonly');
      const q = tx.objectStore('kv').get(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  } catch (e) { return null; }
}

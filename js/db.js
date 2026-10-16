// db.js — Capa de datos.
// Todo lo que lee o escribe en IndexedDB está aquí. El resto de la app
// solo llama a estas funciones y nunca toca IndexedDB directamente.

const DB_NAME = 'habitos';
const DB_VERSION = 1; // súbelo si algún día cambias la estructura (ver onupgradeneeded)

let dbPromise = null;

// Abre (o crea) la base de datos. Solo se abre una vez y se reutiliza.
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    // Se ejecuta la primera vez (o cuando sube DB_VERSION): aquí se crean las "tablas".
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('habits')) {
        db.createObjectStore('habits', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        // Índice para buscar rápido todas las entradas de un hábito
        entries.createIndex('habitId', 'habitId');
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// IndexedDB funciona con eventos, no con promesas. Este helper abre una
// transacción, ejecuta `fn` y resuelve cuando la transacción termina.
// Si `fn` devuelve una petición (IDBRequest), resolvemos con su resultado.
async function tx(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------- Hábitos ----------

export function getHabits() {
  return tx('habits', 'readonly', t => t.objectStore('habits').getAll());
}

// put = insertar o actualizar (si ya existe un registro con ese id, lo reemplaza)
export function saveHabit(habit) {
  return tx('habits', 'readwrite', t => t.objectStore('habits').put(habit));
}

// Borra el hábito Y todas sus entradas, en una sola transacción (o todo o nada).
export function deleteHabit(habitId) {
  return tx(['habits', 'entries'], 'readwrite', t => {
    t.objectStore('habits').delete(habitId);
    const index = t.objectStore('entries').index('habitId');
    index.openCursor(IDBKeyRange.only(habitId)).onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
}

// ---------- Entradas (días completados) ----------

export function getEntries() {
  return tx('entries', 'readonly', t => t.objectStore('entries').getAll());
}

// Marca o desmarca un día. date es un texto 'YYYY-MM-DD'.
export function setEntry(habitId, date, done) {
  const id = `${habitId}|${date}`;
  return tx('entries', 'readwrite', t => {
    const store = t.objectStore('entries');
    if (done) store.put({ id, habitId, date });
    else store.delete(id);
  });
}

// ---------- Copia de seguridad ----------

export async function exportAll() {
  const [habits, entries] = await Promise.all([getHabits(), getEntries()]);
  return { app: 'habitos', version: 1, exportedAt: new Date().toISOString(), habits, entries };
}

// Reemplaza TODOS los datos por los del archivo importado.
export function importAll(data) {
  if (!data || !Array.isArray(data.habits) || !Array.isArray(data.entries)) {
    return Promise.reject(new Error('El archivo no tiene el formato esperado.'));
  }
  return tx(['habits', 'entries'], 'readwrite', t => {
    const habits = t.objectStore('habits');
    const entries = t.objectStore('entries');
    habits.clear();
    entries.clear();
    data.habits.forEach(h => habits.put(h));
    data.entries.forEach(e => entries.put(e));
  });
}

// Pide al navegador que no borre nuestros datos aunque le falte espacio.
// Devuelve true si el almacenamiento queda como "persistente".
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

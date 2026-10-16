// logic.js — Lógica pura: fechas, rachas y estadísticas.
// No toca la base de datos ni el DOM, así que es fácil de entender y de probar.

// ---------- Fechas ----------

// Date -> 'YYYY-MM-DD' en hora LOCAL (no usar toISOString(), que va en UTC).
export function toKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 'YYYY-MM-DD' -> Date a medianoche local
export function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayKey() {
  return toKey(new Date());
}

export function addDays(date, n) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + n);
  return copy;
}

// Días de la semana en el orden español (lunes primero).
// El número es el que devuelve Date.getDay(): 0 = domingo ... 6 = sábado.
export const WEEK = [
  { day: 1, short: 'L', name: 'lunes' },
  { day: 2, short: 'M', name: 'martes' },
  { day: 3, short: 'X', name: 'miércoles' },
  { day: 4, short: 'J', name: 'jueves' },
  { day: 5, short: 'V', name: 'viernes' },
  { day: 6, short: 'S', name: 'sábado' },
  { day: 0, short: 'D', name: 'domingo' },
];

// ¿Le toca a este hábito el día `date`?
export function isScheduled(habit, date) {
  return habit.days.includes(date.getDay());
}

// Texto legible de la frecuencia: "Todos los días", "L, X, V"...
export function describeDays(days) {
  if (days.length === 7) return 'Todos los días';
  if (days.length === 5 && !days.includes(0) && !days.includes(6)) return 'Entre semana';
  if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Fines de semana';
  return WEEK.filter(w => days.includes(w.day)).map(w => w.short).join(', ');
}

// ---------- Rachas y estadísticas ----------
// `done` es un Set con las fechas completadas de un hábito: Set {'2026-10-14', '2026-10-15', ...}

// Fecha más antigua a tener en cuenta: la creación del hábito o la primera entrada.
function startKey(habit, done) {
  let start = habit.createdAt;
  for (const k of done) if (k < start) start = k;
  return start;
}

// Estado global de un día teniendo en cuenta TODOS los hábitos activos.
// `doneMap` es el Map habitId -> Set de fechas que usa app.js.
// Devuelve { status, done, total } donde status es:
//   'complete' -> hiciste todos los hábitos que tocaban
//   'partial'  -> hiciste algunos, pero no todos
//   'missed'   -> no hiciste ninguno
//   'pending'  -> es hoy y aún te quedan por hacer
//   'none'     -> ese día no tocaba ningún hábito
//   'future'   -> todavía no ha llegado
export function dayStatus(habits, doneMap, date) {
  const key = toKey(date);
  if (key > todayKey()) return { status: 'future', done: 0, total: 0 };

  const due = habits.filter(h => {
    if (h.archived || !isScheduled(h, date)) return false;
    return key >= startKey(h, doneMap.get(h.id) ?? new Set()); // el hábito ya existía ese día
  });
  const done = due.filter(h => doneMap.get(h.id)?.has(key)).length;
  const total = due.length;

  let status;
  if (total === 0) status = 'none';
  else if (done === total) status = 'complete';
  else if (key === todayKey()) status = 'pending';
  else status = done > 0 ? 'partial' : 'missed';
  return { status, done, total };
}

// Racha actual: días programados seguidos completados, contando hacia atrás desde hoy.
// Si hoy toca y aún no lo has hecho, la racha NO se rompe: empezamos a contar desde ayer.
export function currentStreak(habit, done) {
  const start = startKey(habit, done);
  let d = new Date();
  if (isScheduled(habit, d) && !done.has(toKey(d))) d = addDays(d, -1);

  let streak = 0;
  while (toKey(d) >= start) {
    if (isScheduled(habit, d)) {
      if (!done.has(toKey(d))) break;
      streak++;
    }
    d = addDays(d, -1);
  }
  return streak;
}

// Mejor racha de la historia: recorremos desde el inicio hasta hoy.
export function bestStreak(habit, done) {
  const today = todayKey();
  let d = fromKey(startKey(habit, done));
  let best = 0;
  let run = 0;
  while (toKey(d) <= today) {
    const key = toKey(d);
    if (isScheduled(habit, d)) {
      if (done.has(key)) {
        run++;
        best = Math.max(best, run);
      } else if (key !== today) {
        run = 0; // hoy sin hacer todavía no rompe nada
      }
    }
    d = addDays(d, 1);
  }
  return best;
}

// % de cumplimiento en los últimos `days` días (solo cuenta días programados).
// Hoy cuenta solo si ya está hecho, para no penalizar a primera hora.
export function completionRate(habit, done, days = 30) {
  const start = startKey(habit, done);
  const today = todayKey();
  let scheduled = 0;
  let completed = 0;
  for (let i = 0; i < days; i++) {
    const d = addDays(new Date(), -i);
    const key = toKey(d);
    if (key < start) break;
    if (!isScheduled(habit, d)) continue;
    if (key === today && !done.has(key)) continue;
    scheduled++;
    if (done.has(key)) completed++;
  }
  return scheduled === 0 ? 0 : Math.round((completed / scheduled) * 100);
}

// Id único para cada hábito nuevo
export function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

// app.js — Interfaz: pinta las pantallas y responde a los toques.
// Flujo: el usuario toca algo -> se guarda en db -> se actualiza `state` -> render()

import * as db from './db.js';
import {
  WEEK, toKey, fromKey, todayKey, addDays, isScheduled, describeDays,
  currentStreak, bestStreak, completionRate, dayStatus, newId,
} from './logic.js';

// ---------- Estado ----------
const state = {
  habits: [],          // lista de hábitos
  done: new Map(),     // habitId -> Set de fechas completadas
  view: 'today',       // 'today' | 'detail' | 'settings'
  habitId: null,       // hábito abierto en la vista de detalle
  editing: null,       // borrador del formulario (crear/editar)
  persisted: false,    // ¿el navegador ha prometido no borrar los datos?
  calMonth: firstOfMonth(new Date()), // mes que muestra el calendario
};

function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

const COLORS = ['#ff453a', '#ff9f0a', '#ffd60a', '#30d158', '#64d2ff', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#8e8e93'];
const EMOJIS = ['💧', '🏃', '📚', '🧘', '💪', '🥗', '😴', '🦷', '💊', '✍️', '🎸', '🚭', '🧹', '🌱', '📵', '🙏', '🚶', '🍎', '🧠', '💰'];

const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const backdrop = document.getElementById('sheet-backdrop');

// ---------- Utilidades ----------

// Escapa texto del usuario antes de meterlo en HTML (evita que "<b>" rompa la página)
function esc(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function doneSet(habitId) {
  if (!state.done.has(habitId)) state.done.set(habitId, new Set());
  return state.done.get(habitId);
}

function findHabit(id) {
  return state.habits.find(h => h.id === id);
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 2500);
}

function isStandalone() {
  return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
}

// ---------- Carga de datos ----------

async function load() {
  const [habits, entries] = await Promise.all([db.getHabits(), db.getEntries()]);
  state.habits = habits.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  state.done = new Map();
  for (const e of entries) doneSet(e.habitId).add(e.date);
}

// ---------- Acciones (modifican datos) ----------

async function toggleDay(habitId, date) {
  const set = doneSet(habitId);
  const done = !set.has(date);
  await db.setEntry(habitId, date, done);   // 1) guardar en la base de datos
  done ? set.add(date) : set.delete(date);  // 2) actualizar el estado en memoria
  render();                                 // 3) redibujar
}

async function saveEditing() {
  const h = state.editing;
  const name = h.name.trim();
  if (!name) return toast('Ponle un nombre al hábito');
  if (h.days.length === 0) return toast('Elige al menos un día');

  const habit = {
    id: h.id || newId(),
    name,
    emoji: h.emoji,
    color: h.color,
    days: [...h.days].sort(),
    createdAt: h.createdAt || todayKey(),
    archived: h.archived || false,
  };
  await db.saveHabit(habit);
  await load();
  closeSheet();
  render();
  // Al guardar el primer hábito pedimos almacenamiento persistente
  state.persisted = await db.requestPersistence();
}

async function setArchived(id, archived) {
  const habit = findHabit(id);
  await db.saveHabit({ ...habit, archived });
  await load();
  if (archived) state.view = 'today';
  render();
  toast(archived ? 'Hábito archivado' : 'Hábito restaurado');
}

async function removeHabit(id) {
  const habit = findHabit(id);
  if (!confirm(`¿Eliminar "${habit.name}" y todo su historial? No se puede deshacer.`)) return;
  await db.deleteHabit(id);
  await load();
  state.view = 'today';
  render();
  toast('Hábito eliminado');
}

async function exportData() {
  const data = await db.exportAll();
  const json = JSON.stringify(data, null, 2);
  const filename = `habitos-${todayKey()}.json`;
  const file = new File([json], filename, { type: 'application/json' });

  // En iPhone, el menú "Compartir" permite guardar en Archivos, iCloud, enviarlo por mail...
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Copia de seguridad de Hábitos' });
    } catch { /* el usuario canceló */ }
    return;
  }
  // En el PC: descarga normal
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    const n = data.habits?.length ?? 0;
    if (!confirm(`Se reemplazarán TODOS tus datos actuales por los del archivo (${n} hábitos). ¿Continuar?`)) return;
    await db.importAll(data);
    await load();
    state.view = 'today';
    render();
    toast('Datos importados');
  } catch (err) {
    alert('No se pudo importar: ' + err.message);
  }
}

// ---------- Vistas (devuelven HTML como texto) ----------

function render() {
  if (state.view === 'detail' && findHabit(state.habitId)) app.innerHTML = viewDetail(findHabit(state.habitId));
  else if (state.view === 'settings') app.innerHTML = viewSettings();
  else {
    state.view = 'today';
    app.innerHTML = viewToday();
  }
}

// Los 7 puntitos de la última semana bajo cada hábito
function weekDots(habit) {
  const done = doneSet(habit.id);
  let html = '';
  for (let i = 6; i >= 0; i--) {
    const d = addDays(new Date(), -i);
    const cls = done.has(toKey(d)) ? 'dot is-done' : isScheduled(habit, d) ? 'dot' : 'dot is-off';
    html += `<span class="${cls}"></span>`;
  }
  return `<span class="dots" aria-hidden="true">${html}</span>`;
}

function habitCard(habit) {
  const today = todayKey();
  const done = doneSet(habit.id).has(today);
  const streak = currentStreak(habit, doneSet(habit.id));
  return `
    <article class="card ${done ? 'is-done' : ''}" style="--c:${habit.color}">
      <button class="card-main" data-action="open" data-id="${habit.id}">
        <span class="emoji">${esc(habit.emoji)}</span>
        <span class="info">
          <span class="name">${esc(habit.name)}</span>
          <span class="meta">${streak > 0 ? `🔥 ${streak} · ` : ''}${describeDays(habit.days)}</span>
          ${weekDots(habit)}
        </span>
      </button>
      <button class="check" data-action="toggle" data-id="${habit.id}" aria-pressed="${done}"
              aria-label="${done ? 'Desmarcar' : 'Marcar'} ${esc(habit.name)}">
        <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
      </button>
    </article>`;
}

// Calendario mensual: cada día se colorea según dayStatus() de logic.js
function viewCalendar() {
  const month = state.calMonth;
  const isCurrentMonth = month.getTime() === firstOfMonth(new Date()).getTime();
  const title = month.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const blanks = (month.getDay() + 6) % 7; // huecos antes del día 1 (la semana empieza en lunes)
  const today = todayKey();

  let cells = '<span class="cal-blank"></span>'.repeat(blanks);
  for (let n = 1; n <= daysInMonth; n++) {
    const date = new Date(month.getFullYear(), month.getMonth(), n);
    const key = toKey(date);
    const { status } = dayStatus(state.habits, state.done, date);
    const cls = `cal-day is-${status}${key === today ? ' is-today' : ''}`;
    cells += status === 'future'
      ? `<span class="${cls}">${n}</span>`
      : `<button class="${cls}" data-action="cal-day" data-date="${key}">${n}</button>`;
  }

  return `
    <section class="panel calendar">
      <div class="cal-head">
        <button class="cal-nav" data-action="cal-prev" aria-label="Mes anterior">‹</button>
        <strong class="cal-title">${esc(title)}</strong>
        <button class="cal-nav" data-action="cal-next" aria-label="Mes siguiente" ${isCurrentMonth ? 'disabled' : ''}>›</button>
      </div>
      <div class="cal-weekdays">
        ${WEEK.map(w => {
          const cls = ['cal-weekday'];
          if (w.day === 0 || w.day === 6) cls.push('is-weekend');
          if (isCurrentMonth && w.day === new Date().getDay()) cls.push('is-today');
          return `<span class="${cls.join(' ')}" title="${w.name}">${w.short}</span>`;
        }).join('')}
      </div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend">
        <span><i class="is-complete"></i>Todo</span>
        <span><i class="is-partial"></i>Parcial</span>
        <span><i class="is-missed"></i>Nada</span>
      </div>
    </section>`;
}

// Aviso al tocar un día del calendario
function showDaySummary(key) {
  const date = fromKey(key);
  const { status, done, total } = dayStatus(state.habits, state.done, date);
  let label = date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  label = label[0].toUpperCase() + label.slice(1);
  if (status === 'none') return toast(`${label}: no tocaba ningún hábito`);
  toast(`${label}: ${done}/${total} completados${status === 'complete' ? ' 🎉' : ''}`);
}

function viewToday() {
  const now = new Date();
  const today = todayKey();
  const active = state.habits.filter(h => !h.archived);
  const due = active.filter(h => isScheduled(h, now));
  const other = active.filter(h => !isScheduled(h, now));
  const doneCount = due.filter(h => doneSet(h.id).has(today)).length;
  const pct = due.length ? Math.round((doneCount / due.length) * 100) : 0;
  const dateText = now.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });

  let body;
  if (active.length === 0) {
    body = `
      <div class="empty">
        <div class="empty-icon">🌱</div>
        <p>Aún no tienes hábitos.</p>
        <button class="btn-primary" data-action="new">Crear mi primer hábito</button>
      </div>`;
  } else {
    body = `
      ${viewCalendar()}
      <div class="progress" style="--p:${pct}%">
        <div class="progress-text"><strong>${doneCount}/${due.length}</strong> completados hoy</div>
        <div class="progress-bar"><span></span></div>
      </div>
      <section class="list">${due.map(habitCard).join('') || '<p class="muted center">Hoy no toca ningún hábito 🎉</p>'}</section>
      ${other.length ? `<h2 class="section-title">Hoy no toca</h2><section class="list is-dim">${other.map(habitCard).join('')}</section>` : ''}
    `;
  }

  const installTip = !isStandalone() && /iPhone|iPad/.test(navigator.userAgent)
    ? `<p class="tip">📲 Para instalarla: pulsa <strong>Compartir</strong> y luego <strong>Añadir a pantalla de inicio</strong>.</p>` : '';

  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">${esc(dateText)}</p>
        <h1>Hoy</h1>
      </div>
      <button class="icon-btn" data-action="settings" aria-label="Ajustes">⚙️</button>
    </header>
    ${installTip}
    ${body}
    ${active.length ? '<button class="fab" data-action="new" aria-label="Nuevo hábito"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>' : ''}
  `;
}

// Cuadrícula tipo GitHub: columnas = semanas, filas = lunes..domingo
function heatmap(habit, weeks = 17) {
  const done = doneSet(habit.id);
  const today = todayKey();
  const now = new Date();
  // Lunes de la semana actual, y retrocedemos (weeks - 1) semanas
  const mondayOffset = (now.getDay() + 6) % 7;
  const start = addDays(now, -mondayOffset - (weeks - 1) * 7);

  let cells = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = addDays(start, i);
    const key = toKey(d);
    if (key > today) {
      cells += '<span class="cell is-future"></span>';
      continue;
    }
    const cls = ['cell'];
    if (done.has(key)) cls.push('is-done');
    else if (!isScheduled(habit, d)) cls.push('is-off');
    if (key === today) cls.push('is-today');
    const label = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });
    cells += `<button class="${cls.join(' ')}" data-action="toggle-day" data-id="${habit.id}" data-date="${key}" aria-label="${label}"></button>`;
  }
  const labels = WEEK.map(w => `<span>${w.short}</span>`).join('');
  return `<div class="heatmap"><div class="heatmap-labels">${labels}</div><div class="heatmap-grid">${cells}</div></div>`;
}

function viewDetail(habit) {
  const done = doneSet(habit.id);
  const since = fromKey(habit.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  return `
    <header class="topbar">
      <button class="back" data-action="home">‹ Hoy</button>
      <button class="link" data-action="edit" data-id="${habit.id}">Editar</button>
    </header>
    <div class="detail-head" style="--c:${habit.color}">
      <span class="emoji big">${esc(habit.emoji)}</span>
      <h1>${esc(habit.name)}</h1>
      <p class="muted">${describeDays(habit.days)} · desde el ${since}</p>
    </div>
    <div class="stats" style="--c:${habit.color}">
      <div class="stat"><strong>${currentStreak(habit, done)}</strong><span>Racha actual</span></div>
      <div class="stat"><strong>${bestStreak(habit, done)}</strong><span>Mejor racha</span></div>
      <div class="stat"><strong>${completionRate(habit, done)}%</strong><span>Últimos 30 días</span></div>
      <div class="stat"><strong>${done.size}</strong><span>Total</span></div>
    </div>
    <h2 class="section-title">Historial</h2>
    <div class="panel" style="--c:${habit.color}">
      ${heatmap(habit)}
      <p class="muted small">Toca un día para marcarlo o desmarcarlo.</p>
    </div>
    <div class="actions">
      <button class="btn-secondary" data-action="archive" data-id="${habit.id}">Archivar</button>
      <button class="btn-danger" data-action="delete" data-id="${habit.id}">Eliminar</button>
    </div>
  `;
}

function viewSettings() {
  const archived = state.habits.filter(h => h.archived);
  return `
    <header class="topbar">
      <button class="back" data-action="home">‹ Hoy</button>
    </header>
    <h1 class="page-title">Ajustes</h1>

    <h2 class="section-title">Copia de seguridad</h2>
    <div class="panel">
      <p class="muted small">Tus datos solo viven en este dispositivo. Exporta una copia de vez en cuando y guárdala en Archivos o iCloud.</p>
      <div class="actions">
        <button class="btn-primary" data-action="export">Exportar datos</button>
        <label class="btn-secondary">Importar datos<input type="file" accept="application/json,.json" data-action="import" hidden></label>
      </div>
    </div>

    <h2 class="section-title">Almacenamiento</h2>
    <div class="panel">
      <p>${state.persisted ? '✅ Persistente: el sistema no borrará tus datos automáticamente.' : '⚠️ No persistente: instala la app en la pantalla de inicio para proteger tus datos.'}</p>
      <p class="muted small">${isStandalone() ? 'Ejecutándose como app instalada.' : 'Ejecutándose en el navegador.'}</p>
    </div>

    ${archived.length ? `
      <h2 class="section-title">Archivados</h2>
      <div class="panel list-plain">
        ${archived.map(h => `
          <div class="row">
            <span>${esc(h.emoji)} ${esc(h.name)}</span>
            <button class="link" data-action="unarchive" data-id="${h.id}">Restaurar</button>
          </div>`).join('')}
      </div>` : ''}
  `;
}

// ---------- Hoja inferior: formulario crear/editar ----------

function openSheet(habit) {
  state.editing = habit
    ? { ...habit, days: [...habit.days] }
    : { id: null, name: '', emoji: EMOJIS[0], color: COLORS[5], days: [0, 1, 2, 3, 4, 5, 6] };
  renderSheet();
  sheet.hidden = false;
  backdrop.hidden = false;
  // Pequeño retardo para que la animación CSS de entrada se vea
  requestAnimationFrame(() => sheet.classList.add('is-open'));
  if (!habit) setTimeout(() => sheet.querySelector('input[name=name]')?.focus(), 300);
}

function closeSheet() {
  sheet.classList.remove('is-open');
  backdrop.hidden = true;
  setTimeout(() => { sheet.hidden = true; }, 250);
  state.editing = null;
}

function renderSheet() {
  const h = state.editing;
  sheet.innerHTML = `
    <div class="sheet-head">
      <button class="link" data-action="cancel">Cancelar</button>
      <strong>${h.id ? 'Editar hábito' : 'Nuevo hábito'}</strong>
      <button class="link bold" data-action="save">Guardar</button>
    </div>
    <label class="field">
      <span>Nombre</span>
      <input name="name" type="text" maxlength="40" placeholder="Ej. Beber 2 L de agua" value="${esc(h.name)}" autocomplete="off">
    </label>
    <div class="field">
      <span>Icono</span>
      <div class="chips">
        ${EMOJIS.map(e => `<button class="chip ${e === h.emoji ? 'is-on' : ''}" data-action="pick-emoji" data-value="${e}">${e}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <span>Color</span>
      <div class="chips">
        ${COLORS.map(c => `<button class="swatch ${c === h.color ? 'is-on' : ''}" style="--c:${c}" data-action="pick-color" data-value="${c}" aria-label="Color ${c}"></button>`).join('')}
      </div>
    </div>
    <div class="field">
      <span>Días</span>
      <div class="days">
        ${WEEK.map(w => `<button class="day ${h.days.includes(w.day) ? 'is-on' : ''}" style="--c:${h.color}" data-action="pick-day" data-value="${w.day}" aria-label="${w.name}">${w.short}</button>`).join('')}
      </div>
      <div class="presets">
        <button class="link" data-action="preset" data-value="0,1,2,3,4,5,6">Todos</button>
        <button class="link" data-action="preset" data-value="1,2,3,4,5">Entre semana</button>
        <button class="link" data-action="preset" data-value="0,6">Fines de semana</button>
      </div>
    </div>
  `;
}

// ---------- Eventos (delegación: un solo listener para todo) ----------

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const { action, id, value, date } = el.dataset;

  switch (action) {
    case 'toggle': return toggleDay(id, todayKey());
    case 'toggle-day': return toggleDay(id, date);
    case 'open': state.view = 'detail'; state.habitId = id; render(); return scrollTo(0, 0);
    case 'home': state.view = 'today'; return render();
    case 'settings': state.view = 'settings'; state.persisted = await db.requestPersistence(); return render();
    case 'new': return openSheet(null);
    case 'edit': return openSheet(findHabit(id));
    case 'cancel': return closeSheet();
    case 'save': return saveEditing();
    case 'archive': return setArchived(id, true);
    case 'unarchive': return setArchived(id, false);
    case 'delete': return removeHabit(id);
    case 'export': return exportData();
    case 'cal-prev':
    case 'cal-next': {
      const m = state.calMonth;
      state.calMonth = new Date(m.getFullYear(), m.getMonth() + (action === 'cal-next' ? 1 : -1), 1);
      return render();
    }
    case 'cal-day': return showDaySummary(date);
    case 'pick-emoji': state.editing.emoji = value; return renderSheet();
    case 'pick-color': state.editing.color = value; return renderSheet();
    case 'pick-day': {
      const day = Number(value);
      const days = state.editing.days;
      state.editing.days = days.includes(day) ? days.filter(d => d !== day) : [...days, day];
      return renderSheet();
    }
    case 'preset': state.editing.days = value.split(',').map(Number); return renderSheet();
  }
});

// El nombre se guarda en el borrador mientras escribes (para no perderlo al redibujar)
sheet.addEventListener('input', e => {
  if (e.target.name === 'name') state.editing.name = e.target.value;
});
sheet.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.name === 'name') saveEditing();
});
backdrop.addEventListener('click', closeSheet);

document.addEventListener('change', e => {
  if (e.target.dataset.action === 'import' && e.target.files[0]) {
    importData(e.target.files[0]);
    e.target.value = '';
  }
});

// Si la app se queda abierta y cambia el día (o vuelves a ella), redibujamos
let lastDay = todayKey();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && todayKey() !== lastDay) {
    lastDay = todayKey();
    render();
  }
});

// ---------- Arranque ----------

async function start() {
  await load();
  render();
  if (navigator.storage?.persisted) state.persisted = await navigator.storage.persisted();
  // El Service Worker permite que la app funcione sin conexión
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW no registrado', err));
  }
}

start();

'use strict';

// =====================================================================
//  BLOCK BLAST — tablero 8x8, 3 piezas por turno, se borran filas y
//  columnas completas. La partida acaba cuando ninguna pieza cabe.
// =====================================================================

const SIZE = 8;
const COLORS = ['#e8473f', '#f39c34', '#f6c933', '#5cc84a', '#3ec6e0', '#3f7fe8', '#9b59e0'];
const STATE_KEY = 'blockblast-state-v1';
const BEST_KEY = 'blockblast-best';
const SOUND_KEY = 'blockblast-sound';

// ----- Formas de las piezas -----
// Cada forma: [dibujo, peso (probabilidad), ¿rotar?, ¿espejo?]
const BASE_SHAPES = [
  [['X'], 1, false, false],
  [['XX'], 2, true, false],
  [['XXX'], 3, true, false],
  [['XXXX'], 3, true, false],
  [['XXXXX'], 2, true, false],
  [['XX', 'XX'], 4, false, false],
  [['XXX', 'XXX', 'XXX'], 2, false, false],
  [['XXX', 'XXX'], 3, true, false],
  [['XX', 'X.'], 3, true, false],
  [['X.', 'X.', 'XX'], 3, true, true],
  [['XXX', '.X.'], 3, true, false],
  [['.XX', 'XX.'], 2, true, true],
  [['XXX', 'X..', 'X..'], 2, true, false],
];

// Convierte el dibujo en una lista de celdas [fila, columna]
function parse(rows) {
  const cells = [];
  rows.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === 'X') cells.push([r, c]); }));
  return cells;
}

// Mueve la forma para que empiece en (0,0) y ordena las celdas
function normalize(cells) {
  const minR = Math.min(...cells.map(p => p[0]));
  const minC = Math.min(...cells.map(p => p[1]));
  return cells.map(([r, c]) => [r - minR, c - minC]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

const rotate = cells => normalize(cells.map(([r, c]) => [c, -r]));
const mirror = cells => normalize(cells.map(([r, c]) => [r, -c]));

// Para cada forma base generamos todas sus variantes (rotaciones/espejos) sin repetir
const SHAPE_GROUPS = BASE_SHAPES.map(([rows, weight, rot, mir]) => {
  const variants = new Map();
  const base = normalize(parse(rows));
  for (let s of (mir ? [base, mirror(base)] : [base])) {
    for (let i = 0; i < (rot ? 4 : 1); i++) {
      variants.set(JSON.stringify(s), s);
      s = rotate(s);
    }
  }
  return { weight, variants: [...variants.values()] };
});
const TOTAL_WEIGHT = SHAPE_GROUPS.reduce((sum, g) => sum + g.weight, 0);

function makePiece(cells, color) {
  return {
    cells,
    w: Math.max(...cells.map(p => p[1])) + 1,
    h: Math.max(...cells.map(p => p[0])) + 1,
    color,
  };
}

function randomPiece() {
  let n = Math.random() * TOTAL_WEIGHT;
  let group = SHAPE_GROUPS[0];
  for (const g of SHAPE_GROUPS) {
    n -= g.weight;
    if (n < 0) { group = g; break; }
  }
  const cells = group.variants[Math.floor(Math.random() * group.variants.length)];
  return makePiece(cells, Math.floor(Math.random() * COLORS.length));
}

// ----- Almacenamiento (envuelto en try/catch por si Safari lo bloquea) -----
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, val) { try { localStorage.setItem(key, val); } catch { /* sin almacenamiento */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* sin almacenamiento */ } },
};

// ----- Estado del juego -----
let board;            // board[fila][col] = índice de color, o -1 si está vacía
let tray;             // las 3 piezas disponibles (null = ya usada)
let score;
let combo;            // racha de jugadas que borran líneas
let movesSinceClear;  // jugadas seguidas sin borrar nada
let gameOver = false;
let best = Number(store.get(BEST_KEY)) || 0;
let shownScore = 0;   // puntuación que se ve (sube poco a poco)

let drag = null;      // pieza que se está arrastrando
let clearing = [];    // bloques animándose al desaparecer
let floats = [];      // textos flotantes (+20, Combo x3...)
let needsDraw = true;

// ----- Elementos de la página -----
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const overlay = document.getElementById('overlay');
const soundBtn = document.getElementById('soundBtn');

// ===================== Lógica del tablero =====================

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(-1));
}

function canPlace(piece, row, col) {
  for (const [r, c] of piece.cells) {
    const rr = row + r, cc = col + c;
    if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE || board[rr][cc] >= 0) return false;
  }
  return true;
}

function fitsAnywhere(piece) {
  for (let r = 0; r <= SIZE - piece.h; r++)
    for (let c = 0; c <= SIZE - piece.w; c++)
      if (canPlace(piece, r, c)) return true;
  return false;
}

// Devuelve las filas y columnas que quedarían completas si se coloca la pieza
function linesIfPlaced(piece, row, col) {
  const extra = new Set(piece.cells.map(([r, c]) => (row + r) * SIZE + (col + c)));
  const filled = (r, c) => board[r][c] >= 0 || extra.has(r * SIZE + c);
  const rows = [], cols = [];
  for (let i = 0; i < SIZE; i++) {
    let rowFull = true, colFull = true;
    for (let j = 0; j < SIZE; j++) {
      if (!filled(i, j)) rowFull = false;
      if (!filled(j, i)) colFull = false;
    }
    if (rowFull) rows.push(i);
    if (colFull) cols.push(i);
  }
  return { rows, cols };
}

// Saca 3 piezas nuevas, intentando que al menos una quepa
function newTray() {
  let pieces;
  for (let tries = 0; tries < 30; tries++) {
    pieces = [randomPiece(), randomPiece(), randomPiece()];
    if (pieces.some(fitsAnywhere)) break;
  }
  return pieces;
}

function newGame() {
  board = emptyBoard();
  score = 0;
  shownScore = 0;
  combo = 0;
  movesSinceClear = 0;
  gameOver = false;
  clearing = [];
  floats = [];
  tray = newTray();
  overlay.hidden = true;
  save();
  needsDraw = true;
}

function placePiece(index, row, col) {
  const piece = tray[index];
  const { rows, cols } = linesIfPlaced(piece, row, col);

  for (const [r, c] of piece.cells) board[row + r][col + c] = piece.color;
  tray[index] = null;
  score += piece.cells.length; // 1 punto por bloque colocado

  const lines = rows.length + cols.length;
  const cx = L.boardX + (col + piece.w / 2) * L.cell;
  const cy = L.boardY + (row + piece.h / 2) * L.cell;

  if (lines > 0) {
    combo++;
    movesSinceClear = 0;

    // Animar y vaciar las celdas de las líneas completas
    const now = performance.now();
    const toClear = new Set();
    rows.forEach(r => { for (let c = 0; c < SIZE; c++) toClear.add(r * SIZE + c); });
    cols.forEach(c => { for (let r = 0; r < SIZE; r++) toClear.add(r * SIZE + c); });
    for (const key of toClear) {
      const r = Math.floor(key / SIZE), c = key % SIZE;
      const dist = Math.abs(r - (row + piece.h / 2)) + Math.abs(c - (col + piece.w / 2));
      clearing.push({ r, c, color: piece.color, start: now + dist * 25 });
      board[r][c] = -1;
    }

    // Puntos: más líneas a la vez y más combo = muchos más puntos
    const gain = 10 * lines * (lines + 1) * combo;
    score += gain;
    addFloat(`+${gain}`, cx, cy, 34, '#fff');
    if (combo > 1) addFloat(`Combo x${combo}`, cx, cy - 40, 26, '#ffd84d');
    else if (lines > 1) addFloat(['', '', '¡Bien!', '¡Genial!', '¡Increíble!'][Math.min(lines, 4)], cx, cy - 40, 26, '#ffd84d');

    if (board.every(row => row.every(v => v < 0))) {
      score += 300;
      addFloat('¡Tablero limpio! +300', L.boardX + L.boardSize / 2, L.boardY + L.boardSize / 2, 28, '#7ef07a');
    }
    sfx('clear', lines);
  } else {
    movesSinceClear++;
    if (movesSinceClear >= 3) combo = 0; // la racha se pierde tras 3 jugadas sin borrar
    sfx('place');
  }

  if (tray.every(p => p === null)) tray = newTray();

  if (score > best) {
    best = score;
    store.set(BEST_KEY, String(best));
  }

  if (!tray.some(p => p && fitsAnywhere(p))) endGame();
  else save();
  needsDraw = true;
}

function endGame() {
  gameOver = true;
  store.remove(STATE_KEY);
  const isRecord = score > 0 && score >= best;
  setTimeout(() => {
    sfx('over');
    document.getElementById('finalScore').textContent = score;
    document.getElementById('newBest').hidden = !isRecord;
    overlay.hidden = false;
  }, 700);
}

// ----- Guardar / cargar la partida (para seguir al reabrir la app) -----
function save() {
  if (gameOver) return;
  store.set(STATE_KEY, JSON.stringify({ board, tray, score, combo, movesSinceClear }));
}

function load() {
  try {
    const s = JSON.parse(store.get(STATE_KEY));
    if (!s || !Array.isArray(s.board) || s.board.length !== SIZE || !Array.isArray(s.tray)) return false;
    board = s.board;
    tray = s.tray.map(p => (p ? makePiece(p.cells, p.color) : null));
    score = s.score || 0;
    shownScore = score;
    combo = s.combo || 0;
    movesSinceClear = s.movesSinceClear || 0;
    if (tray.every(p => p === null)) tray = newTray();
    return true;
  } catch {
    return false;
  }
}

// ===================== Dibujo =====================

let W = 0, H = 0;
const L = {}; // medidas calculadas: tamaño de celda, posición del tablero, bandeja...

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  W = rect.width;
  H = rect.height;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // El tablero ocupa 8 celdas; la bandeja de abajo unas 2.75 celdas más
  L.cell = Math.floor(Math.min((W - 32) / SIZE, (H - 48) / 10.9));
  L.boardSize = L.cell * SIZE;
  L.trayCell = Math.min(L.cell * 0.55, W / 3 / 5.6);
  L.trayH = L.trayCell * 5 + 16;
  const total = L.boardSize + 24 + L.trayH;
  L.boardX = Math.round((W - L.boardSize) / 2);
  L.boardY = Math.max(12, Math.round((H - total) / 2));
  L.trayTop = L.boardY + L.boardSize + 24;
  needsDraw = true;
}

// Aclara (amt > 0) u oscurece (amt < 0) un color
const shadeCache = new Map();
function shade(hex, amt) {
  const key = hex + amt;
  if (shadeCache.has(key)) return shadeCache.get(key);
  const n = parseInt(hex.slice(1), 16);
  const mix = v => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt));
  const out = `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  shadeCache.set(key, out);
  return out;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function poly(points, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
  ctx.closePath();
  ctx.fill();
}

// Dibuja un bloque con efecto 3D (bordes claros arriba, oscuros abajo)
function drawBlock(x, y, s, colorIndex, alpha = 1) {
  const color = COLORS[colorIndex];
  const gap = Math.max(1, s * 0.04);
  x += gap / 2; y += gap / 2; s -= gap;
  const b = s * 0.14;
  ctx.globalAlpha = alpha;
  poly([x, y, x + s, y, x + s - b, y + b, x + b, y + b], shade(color, 0.35));                 // arriba
  poly([x, y, x + b, y + b, x + b, y + s - b, x, y + s], shade(color, 0.15));                 // izquierda
  poly([x + s, y, x + s, y + s, x + s - b, y + s - b, x + s - b, y + b], shade(color, -0.2)); // derecha
  poly([x, y + s, x + b, y + s - b, x + s - b, y + s - b, x + s, y + s], shade(color, -0.35)); // abajo
  ctx.fillStyle = color;
  ctx.fillRect(x + b - 0.5, y + b - 0.5, s - 2 * b + 1, s - 2 * b + 1);
  ctx.globalAlpha = 1;
}

function drawPiece(piece, x, y, cell, alpha = 1) {
  for (const [r, c] of piece.cells) drawBlock(x + c * cell, y + r * cell, cell, piece.color, alpha);
}

function addFloat(text, x, y, size, color) {
  floats.push({ text, x, y, size, color, start: performance.now() });
}

function draw(now) {
  ctx.clearRect(0, 0, W, H);
  const { cell, boardX, boardY, boardSize } = L;

  // Fondo del tablero y huecos vacíos
  ctx.fillStyle = '#1c2756';
  roundRect(boardX - 6, boardY - 6, boardSize + 12, boardSize + 12, 12);
  ctx.fill();
  ctx.fillStyle = '#26336a';
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++)
      ctx.fillRect(boardX + c * cell + 1, boardY + r * cell + 1, cell - 2, cell - 2);

  // Vista previa: dónde caería la pieza y qué líneas se borrarían
  let highlight = null;
  let ghost = null;
  if (drag && drag.snap) {
    const piece = tray[drag.index];
    ghost = { piece, ...drag.snap };
    const { rows, cols } = linesIfPlaced(piece, drag.snap.row, drag.snap.col);
    if (rows.length || cols.length) highlight = { rows: new Set(rows), cols: new Set(cols), color: piece.color };
  }

  // Bloques del tablero
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] < 0) continue;
      const lit = highlight && (highlight.rows.has(r) || highlight.cols.has(c));
      drawBlock(boardX + c * cell, boardY + r * cell, cell, lit ? highlight.color : board[r][c]);
    }
  }

  if (ghost) {
    drawPiece(ghost.piece, boardX + ghost.col * cell, boardY + ghost.row * cell, cell, highlight ? 0.9 : 0.4);
  }

  // Animación de bloques que desaparecen
  clearing = clearing.filter(b => now - b.start < 350);
  for (const b of clearing) {
    const t = Math.max(0, (now - b.start) / 350);
    const s = cell * (1 - t * 0.7);
    drawBlock(boardX + b.c * cell + (cell - s) / 2, boardY + b.r * cell + (cell - s) / 2, s, b.color, 1 - t);
  }

  // Bandeja con las 3 piezas
  const slotW = W / 3;
  tray.forEach((piece, i) => {
    if (!piece || (drag && drag.index === i)) return;
    const tc = L.trayCell;
    const x = slotW * i + slotW / 2 - (piece.w * tc) / 2;
    const y = L.trayTop + L.trayH / 2 - (piece.h * tc) / 2;
    drawPiece(piece, x, y, tc, fitsAnywhere(piece) ? 1 : 0.3);
  });

  // Pieza que se arrastra (a tamaño real)
  if (drag) {
    const piece = tray[drag.index];
    drawPiece(piece, drag.left, drag.top, cell);
  }

  // Textos flotantes
  floats = floats.filter(f => now - f.start < 1000);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const f of floats) {
    const t = (now - f.start) / 1000;
    ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    ctx.font = `800 ${f.size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const y = f.y - t * 50;
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeText(f.text, f.x, y);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, y);
  }
  ctx.globalAlpha = 1;
}

// Bucle de animación: solo redibuja cuando hace falta (ahorra batería)
function frame(now) {
  if (shownScore !== score) {
    shownScore += Math.max(1, Math.ceil((score - shownScore) / 8)) * Math.sign(score - shownScore);
    if (Math.abs(score - shownScore) < 1) shownScore = score;
    scoreEl.textContent = shownScore;
  }
  bestEl.textContent = best;
  if (needsDraw || drag || clearing.length || floats.length) {
    draw(now);
    needsDraw = false;
  }
  requestAnimationFrame(frame);
}

// ===================== Controles (dedo o ratón) =====================

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// Calcula dónde se dibuja la pieza arrastrada y en qué casilla encajaría
function updateDrag(x, y) {
  const piece = tray[drag.index];
  const w = piece.w * L.cell, h = piece.h * L.cell;
  drag.left = x - w / 2;
  // Con el dedo la pieza va por encima para que el dedo no la tape
  drag.top = drag.touch ? y - h - L.cell * 1.2 : y - h / 2;
  const col = Math.round((drag.left - L.boardX) / L.cell);
  const row = Math.round((drag.top - L.boardY) / L.cell);
  drag.snap = canPlace(piece, row, col) ? { row, col } : null;
}

canvas.addEventListener('pointerdown', e => {
  unlockAudio();
  if (gameOver) return;
  const { x, y } = pointerPos(e);
  if (y < L.trayTop - L.cell * 0.5) return; // solo se cogen piezas de la bandeja
  const index = Math.min(2, Math.max(0, Math.floor(x / (W / 3))));
  if (!tray[index]) return;
  drag = { index, touch: e.pointerType !== 'mouse', snap: null };
  updateDrag(x, y);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* algunos navegadores no lo permiten */ }
  sfx('pick');
});

canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const { x, y } = pointerPos(e);
  updateDrag(x, y);
});

function endDrag(drop) {
  if (!drag) return;
  const { index, snap } = drag;
  drag = null;
  needsDraw = true;
  if (drop && snap) placePiece(index, snap.row, snap.col);
}
canvas.addEventListener('pointerup', () => endDrag(true));
canvas.addEventListener('pointercancel', () => endDrag(false));

// Botones
document.getElementById('restartBtn').addEventListener('click', () => {
  if (score === 0 || confirm('¿Empezar una partida nueva?')) newGame();
});
document.getElementById('againBtn').addEventListener('click', newGame);
soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  store.set(SOUND_KEY, soundOn ? '1' : '0');
  soundBtn.textContent = soundOn ? '🔊' : '🔇';
  unlockAudio();
});

// ===================== Sonidos (generados, sin archivos) =====================

let audio = null;
let soundOn = store.get(SOUND_KEY) !== '0';
soundBtn.textContent = soundOn ? '🔊' : '🔇';

// iOS solo permite sonido después de que el usuario toque la pantalla
function unlockAudio() {
  if (!audio) {
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  }
  if (audio.state === 'suspended') audio.resume();
}

function tone(freq, dur, delay, type, vol) {
  if (!soundOn || !audio) return;
  const t = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + dur);
}

function sfx(name, lines = 1) {
  switch (name) {
    case 'pick': tone(600, 0.05, 0, 'triangle', 0.08); break;
    case 'place': tone(200, 0.08, 0, 'triangle', 0.2); break;
    case 'clear':
      [523, 659, 784, 1047, 1319].slice(0, 2 + Math.min(lines, 3))
        .forEach((f, i) => tone(f, 0.18, i * 0.06, 'triangle', 0.12));
      break;
    case 'over': [392, 330, 262].forEach((f, i) => tone(f, 0.3, i * 0.18, 'triangle', 0.15)); break;
  }
}

// ===================== Arranque =====================

window.addEventListener('resize', resize);
resize();
if (!load()) newGame();
scoreEl.textContent = score;
requestAnimationFrame(frame);

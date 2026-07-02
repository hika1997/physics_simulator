'use strict';

/* シミュレーターのUI・描画・メインループ */

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let world = null;
let paused = false;
let timeScale = 1;
let currentPreset = 'balls';

// マウスドラッグ用
let dragBody = null;
let dragSpring = null;
const mouse = { x: 0, y: 0, down: false, downX: 0, downY: 0 };

const FIXED_DT = 1 / 240; // 固定タイムステップ(精度重視)
let accumulator = 0;
let lastTime = null;

// ---- 初期化 ----

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  if (world) {
    world.width = canvas.width;
    world.height = canvas.height;
  }
}

function loadPreset(key) {
  currentPreset = key;
  world = new World(canvas.width, canvas.height);
  world.iterations = 10;
  PRESETS[key].setup(world);
  dragBody = null;
  dragSpring = null;
  syncControlsFromWorld();
  document.getElementById('description').textContent = PRESETS[key].description;
}

function syncControlsFromWorld() {
  const g = document.getElementById('gravity');
  g.value = world.gravity;
  document.getElementById('gravityValue').textContent = Math.round(world.gravity);
  const rest = document.getElementById('restitution');
  document.getElementById('restitutionValue').textContent =
    world.globalRestitution === null ? '自動' : world.globalRestitution.toFixed(2);
  if (world.globalRestitution === null) rest.value = -0.01; // 「自動」位置
}

// ---- メインループ ----

function frame(time) {
  if (lastTime === null) lastTime = time;
  let dt = (time - lastTime) / 1000;
  lastTime = time;
  dt = Math.min(dt, 0.05); // タブ復帰時のスパイク防止

  if (!paused) {
    accumulator += dt * timeScale;
    const maxSteps = 20;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < maxSteps) {
      applyDragForce();
      world.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === maxSteps) accumulator = 0;
  }

  render();
  requestAnimationFrame(frame);
}

function applyDragForce() {
  if (!dragBody || !dragSpring) return;
  dragSpring.anchor.x = mouse.x;
  dragSpring.anchor.y = mouse.y;
}

// ---- 描画 ----

function render() {
  ctx.fillStyle = '#10141c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 軌跡
  for (const b of world.bodies) {
    if (!b.trail || b.trail.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(b.trail[0].x, b.trail[0].y);
    for (const p of b.trail) ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = b.color + '55';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // コンストレイント(ロープ)
  ctx.strokeStyle = '#8892a6';
  ctx.lineWidth = 1.5;
  for (const c of world.constraints) {
    const p2 = c.b ? c.b.pos : c.anchor;
    ctx.beginPath();
    ctx.moveTo(c.a.pos.x, c.a.pos.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    if (!c.b) drawAnchor(c.anchor);
  }

  // バネ(ジグザグ描画)
  for (const s of world.springs) {
    if (s === dragSpring) continue;
    const p2 = s.b ? s.b.pos : s.anchor;
    drawSpring(s.a.pos, p2);
    if (!s.b) drawAnchor(s.anchor);
  }

  // ドラッグ中のガイド線
  if (dragBody && dragSpring) {
    ctx.beginPath();
    ctx.moveTo(dragBody.pos.x, dragBody.pos.y);
    ctx.lineTo(mouse.x, mouse.y);
    ctx.strokeStyle = '#ffffff66';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ボディ
  for (const b of world.bodies) {
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, b.radius, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(
      b.pos.x - b.radius * 0.35, b.pos.y - b.radius * 0.35, b.radius * 0.1,
      b.pos.x, b.pos.y, b.radius,
    );
    grad.addColorStop(0, lighten(b.color, 0.45));
    grad.addColorStop(1, b.color);
    ctx.fillStyle = grad;
    ctx.fill();
    if (b === dragBody) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // ステータス表示
  const ke = world.kineticEnergy();
  document.getElementById('stats').textContent =
    `物体: ${world.bodies.length} | 運動エネルギー: ${Math.round(ke).toLocaleString()}`;
}

function drawAnchor(p) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#8892a6';
  ctx.fill();
}

function drawSpring(p1, p2) {
  const d = { x: p2.x - p1.x, y: p2.y - p1.y };
  const len = Math.hypot(d.x, d.y);
  if (len < 1e-6) return;
  const n = { x: d.x / len, y: d.y / len };
  const perp = { x: -n.y, y: n.x };
  const coils = 8;
  const amp = 6;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  for (let i = 1; i < coils * 2; i++) {
    const t = i / (coils * 2);
    const off = (i % 2 === 1 ? amp : -amp);
    ctx.lineTo(p1.x + d.x * t + perp.x * off, p1.y + d.y * t + perp.y * off);
  }
  ctx.lineTo(p2.x, p2.y);
  ctx.strokeStyle = '#6fbf8f';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function lighten(hex, amount) {
  const num = parseInt(hex.slice(1), 16);
  const r = Math.min(255, (num >> 16) + 255 * amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + 255 * amount);
  const b = Math.min(255, (num & 0xff) + 255 * amount);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// ---- 入力 ----

function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

function onPointerDown(e) {
  const p = canvasPos(e);
  mouse.x = p.x; mouse.y = p.y;
  mouse.downX = p.x; mouse.downY = p.y;
  mouse.down = true;
  const hit = world.bodyAt(p.x, p.y);
  if (hit && !hit.isStatic) {
    dragBody = hit;
    dragSpring = world.addSpring(
      hit, null, { x: p.x, y: p.y }, 0,
      hit.mass * 300, hit.mass * 30,
    );
  }
  e.preventDefault();
}

function onPointerMove(e) {
  const p = canvasPos(e);
  mouse.x = p.x; mouse.y = p.y;
}

function onPointerUp() {
  if (dragSpring) {
    world.springs = world.springs.filter((s) => s !== dragSpring);
    dragSpring = null;
  }
  // クリック(ほぼ動かさず離した)で空きスペースにボール追加
  if (!dragBody && mouse.down) {
    const moved = Math.hypot(mouse.x - mouse.downX, mouse.y - mouse.downY);
    if (moved < 5 && !world.bodyAt(mouse.x, mouse.y)) {
      world.addBody({
        x: mouse.x, y: mouse.y,
        radius: 10 + Math.random() * 18,
        restitution: 0.85,
        color: PALETTE[(Math.random() * PALETTE.length) | 0],
      });
    }
  }
  dragBody = null;
  mouse.down = false;
}

// ---- UI ----

function bindControls() {
  const presetSelect = document.getElementById('preset');
  for (const [key, p] of Object.entries(PRESETS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }
  presetSelect.addEventListener('change', () => loadPreset(presetSelect.value));

  document.getElementById('pauseBtn').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? '▶ 再生' : '⏸ 一時停止';
  });

  document.getElementById('stepBtn').addEventListener('click', () => {
    if (!paused) return;
    for (let i = 0; i < 4; i++) world.step(FIXED_DT);
    render();
  });

  document.getElementById('resetBtn').addEventListener('click', () => loadPreset(currentPreset));

  const gravity = document.getElementById('gravity');
  gravity.addEventListener('input', () => {
    world.gravity = Number(gravity.value);
    document.getElementById('gravityValue').textContent = gravity.value;
  });

  const restitution = document.getElementById('restitution');
  restitution.addEventListener('input', () => {
    const v = Number(restitution.value);
    if (v < 0) {
      world.globalRestitution = null;
      document.getElementById('restitutionValue').textContent = '自動';
    } else {
      world.globalRestitution = v;
      document.getElementById('restitutionValue').textContent = v.toFixed(2);
    }
  });

  const speed = document.getElementById('timeScale');
  speed.addEventListener('input', () => {
    timeScale = Number(speed.value);
    document.getElementById('timeScaleValue').textContent = `${timeScale.toFixed(1)}x`;
  });

  canvas.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  window.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('touchend', onPointerUp);

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      document.getElementById('pauseBtn').click();
    } else if (e.key === 'r' || e.key === 'R') {
      loadPreset(currentPreset);
    }
  });

  window.addEventListener('resize', resizeCanvas);
}

// ---- 起動 ----

resizeCanvas();
bindControls();
loadPreset('balls');
requestAnimationFrame(frame);

'use strict';

/* シミュレーターのUI・描画・メインループ */

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let world = null;
let paused = false;
let timeScale = 1;
let currentPreset = 'balls';
let currentTool = 'grab';
let showVectors = false;

// マウスドラッグ用
let dragBody = null;
let dragSpring = null;
const mouse = { x: 0, y: 0, down: false, downX: 0, downY: 0 };

const FIXED_DT = 1 / 240; // 固定タイムステップ(精度重視)
let accumulator = 0;
let lastTime = null;

// FPS計測
let fps = 0;
let fpsFrames = 0;
let fpsLast = 0;

const ATTRACT_STRENGTH = 3.0e6;

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
  const wind = document.getElementById('wind');
  wind.value = world.wind;
  document.getElementById('windValue').textContent = Math.round(world.wind);
}

// ---- メインループ ----

function frame(time) {
  if (lastTime === null) lastTime = time;
  let dt = (time - lastTime) / 1000;
  lastTime = time;
  dt = Math.min(dt, 0.05); // タブ復帰時のスパイク防止

  fpsFrames++;
  if (time - fpsLast > 500) {
    fps = Math.round((fpsFrames * 1000) / (time - fpsLast));
    fpsFrames = 0;
    fpsLast = time;
  }

  if (!paused) {
    accumulator += dt * timeScale;
    const maxSteps = 20;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < maxSteps) {
      applyPointerEffects();
      world.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === maxSteps) accumulator = 0;
  }

  render();
  requestAnimationFrame(frame);
}

function applyPointerEffects() {
  if (dragBody && dragSpring) {
    dragSpring.anchor.x = mouse.x;
    dragSpring.anchor.y = mouse.y;
  }
  if (mouse.down && (currentTool === 'attract' || currentTool === 'repel')) {
    world.attractor = {
      x: mouse.x, y: mouse.y,
      strength: currentTool === 'attract' ? ATTRACT_STRENGTH : -ATTRACT_STRENGTH,
    };
  } else {
    world.attractor = null;
  }
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

  // コンストレイント(ロープ・布)
  ctx.strokeStyle = '#8892a6';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const c of world.constraints) {
    const p2 = c.b ? c.b.pos : c.anchor;
    ctx.moveTo(c.a.pos.x, c.a.pos.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
  for (const c of world.constraints) {
    if (!c.b) drawAnchor(c.anchor);
  }

  // バネ(ジグザグ描画)
  for (const s of world.springs) {
    if (s === dragSpring) continue;
    const p2 = s.b ? s.b.pos : s.anchor;
    drawSpring(s.a.pos, p2);
    if (!s.b) drawAnchor(s.anchor);
  }

  // エミッター
  for (const e of world.emitters) {
    ctx.beginPath();
    ctx.arc(e.x, e.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff33';
    ctx.fill();
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

  // 引力/斥力エフェクト
  if (world.attractor) {
    const grad = ctx.createRadialGradient(mouse.x, mouse.y, 5, mouse.x, mouse.y, 80);
    const col = world.attractor.strength > 0 ? '74,158,255' : '255,107,107';
    grad.addColorStop(0, `rgba(${col},0.35)`);
    grad.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, 80, 0, Math.PI * 2);
    ctx.fill();
  }

  // ボディ
  for (const b of world.bodies) {
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, b.radius, 0, Math.PI * 2);
    if (b.radius < 7) {
      // 小さい粒子はフラット塗り(描画コスト削減)
      ctx.fillStyle = b.color;
    } else {
      const grad = ctx.createRadialGradient(
        b.pos.x - b.radius * 0.35, b.pos.y - b.radius * 0.35, b.radius * 0.1,
        b.pos.x, b.pos.y, b.radius,
      );
      grad.addColorStop(0, lighten(b.color, 0.45));
      grad.addColorStop(1, b.color);
      ctx.fillStyle = grad;
    }
    ctx.fill();
    if (b.isStatic && b.radius >= 7) {
      ctx.strokeStyle = '#ffffff44';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (b === dragBody) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // 速度ベクトル
  if (showVectors) {
    ctx.strokeStyle = '#ffd166cc';
    ctx.fillStyle = '#ffd166cc';
    ctx.lineWidth = 1.5;
    for (const b of world.bodies) {
      if (b.isStatic) continue;
      const sp = Math.hypot(b.vel.x, b.vel.y);
      if (sp < 10) continue;
      const scale = 0.12;
      drawArrow(b.pos.x, b.pos.y, b.pos.x + b.vel.x * scale, b.pos.y + b.vel.y * scale);
    }
  }

  // ステータス表示
  const ke = world.kineticEnergy();
  document.getElementById('stats').textContent =
    `${fps}fps | 物体: ${world.bodies.length} | 運動エネルギー: ${Math.round(ke).toLocaleString()}`;
}

function drawArrow(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 4) return;
  const nx = dx / len, ny = dy / len;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - nx * 6 - ny * 3, y1 - ny * 6 + nx * 3);
  ctx.lineTo(x1 - nx * 6 + ny * 3, y1 - ny * 6 - nx * 3);
  ctx.closePath();
  ctx.fill();
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
  const src = e.touches ? (e.touches[0] ?? e.changedTouches[0]) : e;
  return { x: src.clientX - rect.left, y: src.clientY - rect.top };
}

function addBallAt(x, y) {
  if (world.bodies.length >= world.maxBodies) return;
  world.addBody({
    x, y,
    radius: 10 + Math.random() * 18,
    restitution: 0.85,
    color: PALETTE[(Math.random() * PALETTE.length) | 0],
  });
}

function onPointerDown(e) {
  const p = canvasPos(e);
  mouse.x = p.x; mouse.y = p.y;
  mouse.downX = p.x; mouse.downY = p.y;
  mouse.down = true;

  if (currentTool === 'grab') {
    const hit = world.bodyAt(p.x, p.y);
    if (hit && !hit.isStatic) {
      dragBody = hit;
      dragSpring = world.addSpring(
        hit, null, { x: p.x, y: p.y }, 0,
        hit.mass * 300, hit.mass * 30,
      );
    }
  } else if (currentTool === 'add') {
    addBallAt(p.x, p.y);
  } else if (currentTool === 'delete') {
    const hit = world.bodyAt(p.x, p.y);
    if (hit) world.removeBody(hit);
  } else if (currentTool === 'pin') {
    const hit = world.bodyAt(p.x, p.y);
    if (hit) hit.setStatic(!hit.isStatic);
  }
  // attract/repel は applyPointerEffects で処理
  e.preventDefault();
}

function onPointerMove(e) {
  const p = canvasPos(e);
  mouse.x = p.x; mouse.y = p.y;
  // 追加/削除ツールはドラッグで連続適用
  if (mouse.down && currentTool === 'delete') {
    const hit = world.bodyAt(p.x, p.y);
    if (hit) world.removeBody(hit);
  }
}

function onPointerUp() {
  if (dragSpring) {
    world.springs = world.springs.filter((s) => s !== dragSpring);
    dragSpring = null;
  }
  // つかむツール: クリック(ほぼ動かさず離した)で空きスペースにボール追加
  if (currentTool === 'grab' && !dragBody && mouse.down) {
    const moved = Math.hypot(mouse.x - mouse.downX, mouse.y - mouse.downY);
    if (moved < 5 && !world.bodyAt(mouse.x, mouse.y)) {
      addBallAt(mouse.x, mouse.y);
    }
  }
  dragBody = null;
  mouse.down = false;
  world.attractor = null;
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

  // ツール切り替え
  for (const btn of document.querySelectorAll('.tool')) {
    btn.addEventListener('click', () => {
      currentTool = btn.dataset.tool;
      for (const b of document.querySelectorAll('.tool')) b.classList.remove('active');
      btn.classList.add('active');
    });
  }

  const gravity = document.getElementById('gravity');
  gravity.addEventListener('input', () => {
    world.gravity = Number(gravity.value);
    document.getElementById('gravityValue').textContent = gravity.value;
  });

  const wind = document.getElementById('wind');
  wind.addEventListener('input', () => {
    world.wind = Number(wind.value);
    document.getElementById('windValue').textContent = wind.value;
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

  document.getElementById('vectors').addEventListener('change', (e) => {
    showVectors = e.target.checked;
  });

  // スマホ用: 詳細設定パネルの開閉
  document.getElementById('menuBtn').addEventListener('click', () => {
    document.getElementById('panel').classList.toggle('open');
  });

  canvas.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('touchstart', onPointerDown, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    onPointerMove(e);
    e.preventDefault(); // スクロール/バウンス防止
  }, { passive: false });
  window.addEventListener('touchend', onPointerUp);

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      document.getElementById('pauseBtn').click();
    } else if (e.key === 'r' || e.key === 'R') {
      loadPreset(currentPreset);
    } else if (e.key === 'v' || e.key === 'V') {
      const cb = document.getElementById('vectors');
      cb.checked = !cb.checked;
      showVectors = cb.checked;
    }
  });

  window.addEventListener('resize', resizeCanvas);
}

// ---- 起動 ----

resizeCanvas();
bindControls();
loadPreset('balls');
requestAnimationFrame(frame);

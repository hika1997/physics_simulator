'use strict';

/**
 * 2D物理エンジン
 * - 円形・箱型剛体(回転対応、セミインプリシット・オイラー積分)
 * - 衝突: 円-円 / 円-箱 / 箱-箱(SAT + 接触面クリッピング)
 * - 回転を考慮したインパルスベースの接触解決(反発・摩擦・位置補正)
 * - 距離コンストレイント / ピン留め(回転自由) / バネ / モーター回転
 * - 空間ハッシュのブロードフェーズ、パーティクルエミッター、相互重力
 */

const Vec = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  cross: (a, b) => a.x * b.y - a.y * b.x,      // 2Dクロス積(スカラー)
  crossSV: (s, v) => ({ x: -s * v.y, y: s * v.x }), // ω × r
  perp: (a) => ({ x: -a.y, y: a.x }),
  len: (a) => Math.hypot(a.x, a.y),
  normalize: (a) => {
    const l = Math.hypot(a.x, a.y);
    return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
  },
};

let nextBodyId = 1;

class Body {
  constructor({
    x, y, vx = 0, vy = 0,
    shape = 'circle',
    radius = 15,          // circle用
    w = 40, h = 40,       // box用
    angle = 0,
    angVel = 0,
    density = 1,
    mass = null,
    restitution = 0.85,
    friction = 0.05,
    color = '#4a9eff',
    isStatic = false,
    trail = false,
    lifetime = null,      // 秒。指定すると寿命で消える(パーティクル用)
    noCollide = false,    // 同じgroupの粒子同士は衝突しない(布用)
    group = 0,
    motor = null,         // rad/s。静的ボディに指定すると定速回転(風車など)
  }) {
    this.id = nextBodyId++;
    this.shape = shape;
    this.pos = { x, y };
    this.vel = { x: vx, y: vy };
    this.force = { x: 0, y: 0 };
    this.angle = angle;
    this.angVel = angVel;
    this.torque = 0;
    this.radius = radius;
    this.hw = w / 2;
    this.hh = h / 2;
    if (shape === 'circle') {
      this.mass = mass ?? density * Math.PI * radius * radius * 0.01;
      this.inertia = 0.5 * this.mass * radius * radius;
    } else {
      this.mass = mass ?? density * w * h * 0.012;
      this.inertia = (this.mass * (w * w + h * h)) / 12;
    }
    this.isStatic = isStatic;
    this.invMass = isStatic ? 0 : 1 / this.mass;
    this.invI = isStatic ? 0 : 1 / this.inertia;
    this.restitution = restitution;
    this.friction = friction;
    this.color = color;
    this.trail = trail ? [] : null;
    this.lifetime = lifetime;
    this.age = 0;
    this.noCollide = noCollide;
    this.group = group;
    this.motor = motor;
  }

  setStatic(flag) {
    this.isStatic = flag;
    this.invMass = flag ? 0 : 1 / this.mass;
    this.invI = flag ? 0 : 1 / this.inertia;
    if (flag) {
      this.vel.x = 0;
      this.vel.y = 0;
      this.angVel = 0;
    }
  }

  // 衝突判定用の外接半径
  boundRadius() {
    return this.shape === 'circle' ? this.radius : Math.hypot(this.hw, this.hh);
  }

  axes() {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    return { ux: { x: c, y: s }, uy: { x: -s, y: c } };
  }

  corners() {
    const { ux, uy } = this.axes();
    const ex = Vec.scale(ux, this.hw), ey = Vec.scale(uy, this.hh);
    const p = this.pos;
    return [
      { x: p.x + ex.x + ey.x, y: p.y + ex.y + ey.y },
      { x: p.x - ex.x + ey.x, y: p.y - ex.y + ey.y },
      { x: p.x - ex.x - ey.x, y: p.y - ex.y - ey.y },
      { x: p.x + ex.x - ey.x, y: p.y + ex.y - ey.y },
    ];
  }

  containsPoint(x, y, pad = 0) {
    if (this.shape === 'circle') {
      const dx = this.pos.x - x, dy = this.pos.y - y;
      return dx * dx + dy * dy <= (this.radius + pad) * (this.radius + pad);
    }
    const { ux, uy } = this.axes();
    const d = { x: x - this.pos.x, y: y - this.pos.y };
    return Math.abs(Vec.dot(d, ux)) <= this.hw + pad && Math.abs(Vec.dot(d, uy)) <= this.hh + pad;
  }
}

class DistanceConstraint {
  // bodyB が null の場合は固定点 anchor に接続。length 0 でピン留め(回転自由)
  constructor(bodyA, bodyB, anchor = null, length = null) {
    this.a = bodyA;
    this.b = bodyB;
    this.anchor = anchor;
    const p2 = bodyB ? bodyB.pos : anchor;
    this.length = length ?? Vec.len(Vec.sub(bodyA.pos, p2));
  }
}

class Spring {
  constructor(bodyA, bodyB, anchor = null, restLength = null, stiffness = 50, damping = 2) {
    this.a = bodyA;
    this.b = bodyB;
    this.anchor = anchor;
    const p2 = bodyB ? bodyB.pos : anchor;
    this.restLength = restLength ?? Vec.len(Vec.sub(bodyA.pos, p2));
    this.stiffness = stiffness;
    this.damping = damping;
  }
}

class Emitter {
  constructor({
    x, y,
    rate = 20,
    speed = 400,
    angle = -Math.PI / 2,
    spread = 0.3,
    radius = 5,
    radiusJitter = 3,
    lifetime = 6,
    colors = ['#4a9eff'],
    maxAlive = 250,
  }) {
    Object.assign(this, { x, y, rate, speed, angle, spread, radius, radiusJitter, lifetime, colors, maxAlive });
    this.accum = 0;
    this.alive = 0;
  }
}

// ---- 衝突マニフォールド生成 ----

function collideCircleCircle(a, b) {
  const d = Vec.sub(b.pos, a.pos);
  const dist = Vec.len(d);
  const minDist = a.radius + b.radius;
  if (dist >= minDist || dist < 1e-9) return null;
  const normal = Vec.scale(d, 1 / dist);
  const pen = minDist - dist;
  const contact = {
    x: a.pos.x + normal.x * (a.radius - pen / 2),
    y: a.pos.y + normal.y * (a.radius - pen / 2),
    pen,
  };
  return { normal, contacts: [contact] };
}

// 円(a=circle)と箱(b=box)。normal は a→b 向き
function collideCircleBox(circle, box) {
  const { ux, uy } = box.axes();
  const d = Vec.sub(circle.pos, box.pos);
  const lx = Vec.dot(d, ux), ly = Vec.dot(d, uy);
  const cx = Math.max(-box.hw, Math.min(box.hw, lx));
  const cy = Math.max(-box.hh, Math.min(box.hh, ly));
  let inside = false;
  let qx = cx, qy = cy;
  if (lx === cx && ly === cy) {
    // 中心が箱の内部 → 最も近い面へ押し出す
    inside = true;
    const dxp = box.hw - Math.abs(lx), dyp = box.hh - Math.abs(ly);
    if (dxp < dyp) qx = lx > 0 ? box.hw : -box.hw;
    else qy = ly > 0 ? box.hh : -box.hh;
  }
  const closest = {
    x: box.pos.x + ux.x * qx + uy.x * qy,
    y: box.pos.y + ux.y * qx + uy.y * qy,
  };
  const diff = Vec.sub(closest, circle.pos);
  const dist = Vec.len(diff);
  if (!inside && dist >= circle.radius) return null;
  let normal, pen;
  if (inside) {
    normal = Vec.normalize(diff); // 円→箱表面 = 円→箱 方向
    pen = circle.radius + dist;
  } else if (dist < 1e-9) {
    normal = { x: 0, y: 1 };
    pen = circle.radius;
  } else {
    normal = Vec.scale(diff, 1 / dist);
    pen = circle.radius - dist;
  }
  return { normal, contacts: [{ x: closest.x, y: closest.y, pen }] };
}

function projectRadius(box, axis) {
  const { ux, uy } = box.axes();
  return box.hw * Math.abs(Vec.dot(ux, axis)) + box.hh * Math.abs(Vec.dot(uy, axis));
}

// 線分をハーフプレーン dot(n,p) <= c でクリップ
function clipSegment(points, n, c) {
  const out = [];
  const d0 = Vec.dot(n, points[0]) - c;
  const d1 = Vec.dot(n, points[1]) - c;
  if (d0 <= 0) out.push(points[0]);
  if (d1 <= 0) out.push(points[1]);
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    out.push({
      x: points[0].x + t * (points[1].x - points[0].x),
      y: points[0].y + t * (points[1].y - points[0].y),
    });
  }
  return out;
}

// 箱同士: SAT + リファレンス面クリッピング。normal は a→b 向き
function collideBoxBox(a, b) {
  const d = Vec.sub(b.pos, a.pos);
  const axesList = [];
  const aAxes = a.axes(), bAxes = b.axes();
  axesList.push({ n: aAxes.ux, owner: a, extent: a.hw });
  axesList.push({ n: aAxes.uy, owner: a, extent: a.hh });
  axesList.push({ n: bAxes.ux, owner: b, extent: b.hw });
  axesList.push({ n: bAxes.uy, owner: b, extent: b.hh });

  let best = null;
  for (const ax of axesList) {
    const ra = projectRadius(a, ax.n);
    const rb = projectRadius(b, ax.n);
    const dist = Math.abs(Vec.dot(d, ax.n));
    const overlap = ra + rb - dist;
    if (overlap <= 0) return null; // 分離軸あり
    if (best === null || overlap < best.overlap) {
      best = { ...ax, overlap };
    }
  }

  // normal を a→b 向きに揃える
  let normal = best.n;
  if (Vec.dot(d, normal) < 0) normal = Vec.scale(normal, -1);

  const ref = best.owner;
  const inc = ref === a ? b : a;
  // リファレンス面の外向き法線(ref→inc 方向)
  const refN = ref === a ? normal : Vec.scale(normal, -1);

  // インシデント面: 外向き法線が refN と最も逆向きの面
  const incAxes = inc.axes();
  const candidates = [
    { n: incAxes.ux, e: inc.hw, side: incAxes.uy, se: inc.hh },
    { n: Vec.scale(incAxes.ux, -1), e: inc.hw, side: incAxes.uy, se: inc.hh },
    { n: incAxes.uy, e: inc.hh, side: incAxes.ux, se: inc.hw },
    { n: Vec.scale(incAxes.uy, -1), e: inc.hh, side: incAxes.ux, se: inc.hw },
  ];
  let incFace = candidates[0], minDot = Infinity;
  for (const f of candidates) {
    const dt = Vec.dot(f.n, refN);
    if (dt < minDot) { minDot = dt; incFace = f; }
  }
  const faceCenter = Vec.add(inc.pos, Vec.scale(incFace.n, incFace.e));
  let pts = [
    Vec.add(faceCenter, Vec.scale(incFace.side, incFace.se)),
    Vec.sub(faceCenter, Vec.scale(incFace.side, incFace.se)),
  ];

  // リファレンス面のサイド平面でクリップ
  const side = Vec.perp(refN);
  const refSideExtent = projectRadius(ref, side);
  const posSide = Vec.dot(side, ref.pos);
  pts = clipSegment(pts, side, posSide + refSideExtent);
  if (pts.length < 2) return null;
  pts = clipSegment(pts, Vec.scale(side, -1), -(posSide - refSideExtent));
  if (pts.length < 2) return null;

  // リファレンス面より内側の点だけ接触点にする
  const refFaceDist = Vec.dot(refN, ref.pos) + best.extent;
  const contacts = [];
  for (const p of pts) {
    const sep = Vec.dot(refN, p) - refFaceDist;
    if (sep <= 0) contacts.push({ x: p.x, y: p.y, pen: -sep });
  }
  if (contacts.length === 0) return null;
  return { normal, contacts };
}

function collide(a, b) {
  if (a.shape === 'circle' && b.shape === 'circle') return collideCircleCircle(a, b);
  if (a.shape === 'circle' && b.shape === 'box') return collideCircleBox(a, b);
  if (a.shape === 'box' && b.shape === 'circle') {
    const m = collideCircleBox(b, a);
    if (!m) return null;
    m.normal = Vec.scale(m.normal, -1); // a→b に揃える
    return m;
  }
  return collideBoxBox(a, b);
}

// ---- ワールド ----

class World {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.bodies = [];
    this.constraints = [];
    this.springs = [];
    this.emitters = [];
    this.gravity = 500;            // px/s^2(下向き)
    this.wind = 0;                 // 横方向の力(px/s^2)
    this.mutualGravity = false;    // 惑星軌道モード
    this.mutualG = 8000;           // 万有引力定数(px単位系)
    this.walls = true;             // 画面端で反射するか
    this.globalRestitution = null; // nullなら各Bodyの値を使う
    this.airDrag = 0;              // 空気抵抗係数
    this.iterations = 10;          // コンストレイント/衝突の反復回数
    this.maxTrail = 400;
    this.maxBodies = 600;          // パフォーマンス保護
    this.attractor = null;         // {x, y, strength} ポインタ引力/斥力
    this.onImpact = null;          // (法線相対速度, x, y, 代表サイズ) 衝突コールバック
    this._grid = new Map();        // 空間ハッシュ(ブロードフェーズ)
  }

  addBody(opts) {
    const b = opts instanceof Body ? opts : new Body(opts);
    this.bodies.push(b);
    return b;
  }

  addConstraint(a, b, anchor, length) {
    const c = new DistanceConstraint(a, b, anchor, length);
    this.constraints.push(c);
    return c;
  }

  // 中心を固定点/相手に留める(回転は自由)
  addPin(a, anchor) {
    return this.addConstraint(a, null, anchor, 0);
  }

  addSpring(a, b, anchor, restLength, stiffness, damping) {
    const s = new Spring(a, b, anchor, restLength, stiffness, damping);
    this.springs.push(s);
    return s;
  }

  addEmitter(opts) {
    const e = new Emitter(opts);
    this.emitters.push(e);
    return e;
  }

  removeBody(body) {
    this.bodies = this.bodies.filter((b) => b !== body);
    this.constraints = this.constraints.filter((c) => c.a !== body && c.b !== body);
    this.springs = this.springs.filter((s) => s.a !== body && s.b !== body);
  }

  clear() {
    this.bodies = [];
    this.constraints = [];
    this.springs = [];
    this.emitters = [];
    this.attractor = null;
  }

  restitutionOf(body) {
    return this.globalRestitution ?? body.restitution;
  }

  step(dt) {
    this.runEmitters(dt);
    this.applyForces(dt);
    this.integrateVelocities(dt);
    for (let i = 0; i < this.iterations; i++) {
      this.solveConstraintVelocities();
    }
    this.integratePositions(dt);
    for (let i = 0; i < this.iterations; i++) {
      this.solveConstraintPositions();
      this.solveCollisions(i === 0);
      if (this.walls) this.solveWalls(i === 0);
    }
    this.updateTrails();
    this.reapBodies(dt);
  }

  runEmitters(dt) {
    for (const e of this.emitters) {
      e.accum += e.rate * dt;
      while (e.accum >= 1) {
        e.accum -= 1;
        if (e.alive >= e.maxAlive || this.bodies.length >= this.maxBodies) continue;
        const a = e.angle + (Math.random() - 0.5) * e.spread;
        const sp = e.speed * (0.85 + Math.random() * 0.3);
        const b = this.addBody({
          x: e.x, y: e.y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          radius: e.radius + Math.random() * e.radiusJitter,
          restitution: 0.6,
          lifetime: e.lifetime,
          color: e.colors[(Math.random() * e.colors.length) | 0],
        });
        b._emitter = e;
        e.alive++;
      }
    }
  }

  reapBodies(dt) {
    const margin = 200;
    let removed = null;
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      if (b.lifetime !== null) {
        b.age += dt;
        if (b.age >= b.lifetime) (removed ??= []).push(b);
      }
      // 壁なしモードで画面外に大きく出た物体を回収
      if (!this.walls && (
        b.pos.x < -margin || b.pos.x > this.width + margin ||
        b.pos.y < -margin || b.pos.y > this.height + margin
      ) && b.lifetime !== null) {
        (removed ??= []).push(b);
      }
    }
    if (removed) {
      const set = new Set(removed);
      for (const b of set) if (b._emitter) b._emitter.alive--;
      this.bodies = this.bodies.filter((b) => !set.has(b));
      this.constraints = this.constraints.filter((c) => !set.has(c.a) && !set.has(c.b));
      this.springs = this.springs.filter((s) => !set.has(s.a) && !set.has(s.b));
    }
  }

  applyForces(dt) {
    for (const b of this.bodies) {
      b.force.x = 0;
      b.force.y = 0;
      b.torque = 0;
      if (b.isStatic) continue;
      b.force.y += this.gravity * b.mass;
      b.force.x += this.wind * b.mass;
      if (this.airDrag > 0) {
        b.force.x -= b.vel.x * this.airDrag * b.mass;
        b.force.y -= b.vel.y * this.airDrag * b.mass;
        b.torque -= b.angVel * this.airDrag * b.inertia;
      }
    }
    if (this.attractor) this.applyAttractor();
    if (this.mutualGravity) this.applyMutualGravity();
    for (const s of this.springs) this.applySpring(s);
  }

  applyAttractor() {
    const { x, y, strength } = this.attractor;
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      const dx = x - b.pos.x, dy = y - b.pos.y;
      const dist = Math.max(Math.hypot(dx, dy), 30);
      const f = (strength * b.mass) / dist;
      b.force.x += (dx / dist) * f;
      b.force.y += (dy / dist) * f;
    }
  }

  applyMutualGravity() {
    const n = this.bodies.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.bodies[i], b = this.bodies[j];
        const d = Vec.sub(b.pos, a.pos);
        const distSq = Math.max(d.x * d.x + d.y * d.y, 100);
        const dist = Math.sqrt(distSq);
        const f = (this.mutualG * a.mass * b.mass) / distSq;
        const nx = d.x / dist, ny = d.y / dist;
        a.force.x += f * nx; a.force.y += f * ny;
        b.force.x -= f * nx; b.force.y -= f * ny;
      }
    }
  }

  applySpring(s) {
    const p2 = s.b ? s.b.pos : s.anchor;
    const d = Vec.sub(p2, s.a.pos);
    const dist = Vec.len(d);
    if (dist < 1e-9) return;
    const n = Vec.scale(d, 1 / dist);
    const v2 = s.b ? s.b.vel : { x: 0, y: 0 };
    const relVel = Vec.dot(Vec.sub(v2, s.a.vel), n);
    const f = s.stiffness * (dist - s.restLength) + s.damping * relVel;
    s.a.force.x += f * n.x;
    s.a.force.y += f * n.y;
    if (s.b) {
      s.b.force.x -= f * n.x;
      s.b.force.y -= f * n.y;
    }
  }

  integrateVelocities(dt) {
    for (const b of this.bodies) {
      if (b.isStatic) {
        // モーター付き静的ボディ(風車など)は定速回転
        if (b.motor !== null) b.angVel = b.motor;
        continue;
      }
      b.vel.x += b.force.x * b.invMass * dt;
      b.vel.y += b.force.y * b.invMass * dt;
      b.angVel += b.torque * b.invI * dt;
      if (b.motor !== null) b.angVel = b.motor;
    }
  }

  integratePositions(dt) {
    for (const b of this.bodies) {
      if (b.isStatic) {
        if (b.motor !== null) b.angle += b.angVel * dt;
        continue;
      }
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.angle += b.angVel * dt;
    }
  }

  solveConstraintVelocities() {
    for (const c of this.constraints) {
      const p2 = c.b ? c.b.pos : c.anchor;
      const invMassSum = c.a.invMass + (c.b ? c.b.invMass : 0);
      if (invMassSum === 0) continue;
      if (c.length === 0) {
        // ピン: 相対速度(両成分)を打ち消す
        const v2 = c.b ? c.b.vel : { x: 0, y: 0 };
        const rvx = v2.x - c.a.vel.x, rvy = v2.y - c.a.vel.y;
        c.a.vel.x += (rvx * c.a.invMass) / invMassSum;
        c.a.vel.y += (rvy * c.a.invMass) / invMassSum;
        if (c.b) {
          c.b.vel.x -= (rvx * c.b.invMass) / invMassSum;
          c.b.vel.y -= (rvy * c.b.invMass) / invMassSum;
        }
        continue;
      }
      const n = Vec.normalize(Vec.sub(p2, c.a.pos));
      const v2 = c.b ? c.b.vel : { x: 0, y: 0 };
      const relVel = Vec.dot(Vec.sub(v2, c.a.vel), n);
      const impulse = relVel / invMassSum;
      c.a.vel.x += impulse * c.a.invMass * n.x;
      c.a.vel.y += impulse * c.a.invMass * n.y;
      if (c.b) {
        c.b.vel.x -= impulse * c.b.invMass * n.x;
        c.b.vel.y -= impulse * c.b.invMass * n.y;
      }
    }
  }

  solveConstraintPositions() {
    for (const c of this.constraints) {
      const p2 = c.b ? c.b.pos : c.anchor;
      const invMassSum = c.a.invMass + (c.b ? c.b.invMass : 0);
      if (invMassSum === 0) continue;
      const d = Vec.sub(p2, c.a.pos);
      if (c.length === 0) {
        // ピン: 位置を一致させる
        c.a.pos.x += (d.x * c.a.invMass) / invMassSum;
        c.a.pos.y += (d.y * c.a.invMass) / invMassSum;
        if (c.b) {
          c.b.pos.x -= (d.x * c.b.invMass) / invMassSum;
          c.b.pos.y -= (d.y * c.b.invMass) / invMassSum;
        }
        continue;
      }
      const dist = Vec.len(d);
      if (dist < 1e-9) continue;
      const n = Vec.scale(d, 1 / dist);
      const error = dist - c.length;
      const corr = error / invMassSum;
      c.a.pos.x += corr * c.a.invMass * n.x;
      c.a.pos.y += corr * c.a.invMass * n.y;
      if (c.b) {
        c.b.pos.x -= corr * c.b.invMass * n.x;
        c.b.pos.y -= corr * c.b.invMass * n.y;
      }
    }
  }

  solveCollisions(firstIter) {
    const n = this.bodies.length;
    if (n < 40) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          this.resolvePair(this.bodies[i], this.bodies[j], firstIter);
        }
      }
      return;
    }
    let maxR = 8;
    for (const b of this.bodies) {
      const r = b.boundRadius();
      if (r > maxR) maxR = r;
    }
    const cell = maxR * 2;
    const grid = this._grid;
    grid.clear();
    for (const b of this.bodies) {
      const key = ((b.pos.x / cell) | 0) * 73856093 ^ ((b.pos.y / cell) | 0) * 19349663;
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, bucket = []);
      bucket.push(b);
    }
    for (const b of this.bodies) {
      const cx = (b.pos.x / cell) | 0, cy = (b.pos.y / cell) | 0;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          const bucket = grid.get(gx * 73856093 ^ gy * 19349663);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other.id <= b.id) continue;
            this.resolvePair(b, other, firstIter);
          }
        }
      }
    }
  }

  resolvePair(a, b, firstIter) {
    if (a.invMass + b.invMass === 0) return;
    if (a.noCollide && b.noCollide && a.group === b.group) return;
    // 外接円で早期リターン
    const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y;
    const rr = a.boundRadius() + b.boundRadius();
    if (dx * dx + dy * dy > rr * rr) return;

    const m = collide(a, b);
    if (!m) return;
    this.resolveManifold(a, b, m, firstIter);
  }

  resolveManifold(a, b, m, firstIter) {
    const n = m.normal; // a→b
    const e = Math.min(this.restitutionOf(a), this.restitutionOf(b));
    const mu = Math.max(a.friction, b.friction);

    for (const c of m.contacts) {
      const ra = { x: c.x - a.pos.x, y: c.y - a.pos.y };
      const rb = { x: c.x - b.pos.x, y: c.y - b.pos.y };
      // 接触点での相対速度
      const va = Vec.add(a.vel, Vec.crossSV(a.angVel, ra));
      const vb = Vec.add(b.vel, Vec.crossSV(b.angVel, rb));
      const rv = Vec.sub(vb, va);
      const vn = Vec.dot(rv, n);
      if (vn > 0) continue;

      const raCn = Vec.cross(ra, n), rbCn = Vec.cross(rb, n);
      const kn = a.invMass + b.invMass + raCn * raCn * a.invI + rbCn * rbCn * b.invI;
      if (kn === 0) continue;
      // 微小速度では反発させない(スタック安定化)
      const rest = Math.abs(vn) > 40 ? e : 0;
      const jn = (-(1 + rest) * vn) / kn / m.contacts.length;

      const Pn = Vec.scale(n, jn);
      a.vel.x -= Pn.x * a.invMass; a.vel.y -= Pn.y * a.invMass;
      a.angVel -= Vec.cross(ra, Pn) * a.invI;
      b.vel.x += Pn.x * b.invMass; b.vel.y += Pn.y * b.invMass;
      b.angVel += Vec.cross(rb, Pn) * b.invI;

      // 摩擦
      const t = Vec.perp(n);
      const va2 = Vec.add(a.vel, Vec.crossSV(a.angVel, ra));
      const vb2 = Vec.add(b.vel, Vec.crossSV(b.angVel, rb));
      const vt = Vec.dot(Vec.sub(vb2, va2), t);
      const raCt = Vec.cross(ra, t), rbCt = Vec.cross(rb, t);
      const kt = a.invMass + b.invMass + raCt * raCt * a.invI + rbCt * rbCt * b.invI;
      if (kt > 0) {
        const jtMax = Math.abs(mu * jn);
        const jt = Math.max(-jtMax, Math.min(jtMax, -vt / kt));
        const Pt = Vec.scale(t, jt);
        a.vel.x -= Pt.x * a.invMass; a.vel.y -= Pt.y * a.invMass;
        a.angVel -= Vec.cross(ra, Pt) * a.invI;
        b.vel.x += Pt.x * b.invMass; b.vel.y += Pt.y * b.invMass;
        b.angVel += Vec.cross(rb, Pt) * b.invI;
      }

      if (firstIter && this.onImpact && Math.abs(vn) > 90) {
        this.onImpact(Math.abs(vn), c.x, c.y, Math.min(a.boundRadius(), b.boundRadius()));
      }
    }

    // 位置補正(めり込み解消、並進のみ)
    const invMassSum = a.invMass + b.invMass;
    if (invMassSum > 0) {
      let maxPen = 0;
      for (const c of m.contacts) if (c.pen > maxPen) maxPen = c.pen;
      const corr = (Math.max(maxPen - 0.5, 0) / invMassSum) * 0.4;
      a.pos.x -= corr * a.invMass * n.x;
      a.pos.y -= corr * a.invMass * n.y;
      b.pos.x += corr * b.invMass * n.x;
      b.pos.y += corr * b.invMass * n.y;
    }
  }

  solveWalls(firstIter) {
    // 壁は4つのハーフプレーン。n は物体→壁の外向き
    const planes = [
      { n: { x: -1, y: 0 }, offset: 0 },              // 左: -x <= 0
      { n: { x: 1, y: 0 }, offset: this.width },      // 右: x <= width
      { n: { x: 0, y: -1 }, offset: 0 },              // 上
      { n: { x: 0, y: 1 }, offset: this.height },     // 下(床)
    ];
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      for (const pl of planes) {
        if (b.shape === 'circle') {
          const d = Vec.dot(pl.n, b.pos) - pl.offset + b.radius;
          if (d > 0) {
            const contact = {
              x: b.pos.x + pl.n.x * b.radius,
              y: b.pos.y + pl.n.y * b.radius,
              pen: d,
            };
            this.resolveWallContact(b, pl.n, contact, firstIter);
          }
        } else {
          for (const corner of b.corners()) {
            const d = Vec.dot(pl.n, corner) - pl.offset;
            if (d > 0) {
              this.resolveWallContact(b, pl.n, { x: corner.x, y: corner.y, pen: d }, firstIter);
            }
          }
        }
      }
    }
  }

  resolveWallContact(b, wallN, c, firstIter) {
    // n は物体→壁向き。衝突法線として反転して扱う(壁→物体)
    const n = { x: -wallN.x, y: -wallN.y };
    const r = { x: c.x - b.pos.x, y: c.y - b.pos.y };
    const v = Vec.add(b.vel, Vec.crossSV(b.angVel, r));
    const vn = Vec.dot(v, n);
    if (vn < 0) {
      const rCn = Vec.cross(r, n);
      const kn = b.invMass + rCn * rCn * b.invI;
      if (kn > 0) {
        const e = Math.abs(vn) > 40 ? this.restitutionOf(b) : 0;
        const jn = (-(1 + e) * vn) / kn;
        const Pn = Vec.scale(n, jn);
        b.vel.x += Pn.x * b.invMass; b.vel.y += Pn.y * b.invMass;
        b.angVel += Vec.cross(r, Pn) * b.invI;
        // 摩擦
        const t = Vec.perp(n);
        const v2 = Vec.add(b.vel, Vec.crossSV(b.angVel, r));
        const vt = Vec.dot(v2, t);
        const rCt = Vec.cross(r, t);
        const kt = b.invMass + rCt * rCt * b.invI;
        if (kt > 0) {
          const jtMax = Math.abs(Math.max(b.friction, 0.15) * jn);
          const jt = Math.max(-jtMax, Math.min(jtMax, -vt / kt));
          const Pt = Vec.scale(t, jt);
          b.vel.x += Pt.x * b.invMass; b.vel.y += Pt.y * b.invMass;
          b.angVel += Vec.cross(r, Pt) * b.invI;
        }
        if (firstIter && this.onImpact && Math.abs(vn) > 90) {
          this.onImpact(Math.abs(vn), c.x, c.y, b.boundRadius());
        }
      }
    }
    // 位置補正
    const corr = Math.max(c.pen - 0.5, 0) * 0.4;
    b.pos.x += n.x * corr;
    b.pos.y += n.y * corr;
  }

  updateTrails() {
    for (const b of this.bodies) {
      if (!b.trail) continue;
      b.trail.push({ x: b.pos.x, y: b.pos.y });
      if (b.trail.length > this.maxTrail) b.trail.shift();
    }
  }

  kineticEnergy() {
    let ke = 0;
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      ke += 0.5 * b.mass * (b.vel.x * b.vel.x + b.vel.y * b.vel.y);
      ke += 0.5 * b.inertia * b.angVel * b.angVel;
    }
    return ke;
  }

  bodyAt(x, y) {
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      if (this.bodies[i].containsPoint(x, y, 5)) return this.bodies[i];
    }
    return null;
  }
}

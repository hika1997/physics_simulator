'use strict';

/**
 * 2D物理エンジン
 * - 円形剛体(セミインプリシット・オイラー積分)
 * - 円同士 / 壁との衝突(インパルスベース + 位置補正)
 * - 距離コンストレイント(振り子・ロープ用、逐次インパルス法)
 * - バネ、相互重力(惑星軌道用)
 */

const Vec = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
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
    radius = 15,
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
  }) {
    this.id = nextBodyId++;
    this.pos = { x, y };
    this.vel = { x: vx, y: vy };
    this.force = { x: 0, y: 0 };
    this.radius = radius;
    this.mass = mass ?? density * Math.PI * radius * radius * 0.01;
    this.invMass = isStatic ? 0 : 1 / this.mass;
    this.isStatic = isStatic;
    this.restitution = restitution;
    this.friction = friction;
    this.color = color;
    this.trail = trail ? [] : null;
    this.lifetime = lifetime;
    this.age = 0;
    this.noCollide = noCollide;
    this.group = group;
  }

  setStatic(flag) {
    this.isStatic = flag;
    this.invMass = flag ? 0 : 1 / this.mass;
    if (flag) {
      this.vel.x = 0;
      this.vel.y = 0;
    }
  }
}

class Emitter {
  constructor({
    x, y,
    rate = 20,          // 個/秒
    speed = 400,
    angle = -Math.PI / 2, // 射出方向(ラジアン、-90°=上)
    spread = 0.3,        // 角度のばらつき
    radius = 5,
    radiusJitter = 3,
    lifetime = 6,
    colors = ['#4a9eff'],
    maxAlive = 250,      // このエミッター由来の最大生存数
  }) {
    Object.assign(this, { x, y, rate, speed, angle, spread, radius, radiusJitter, lifetime, colors, maxAlive });
    this.accum = 0;
    this.alive = 0;
  }
}

class DistanceConstraint {
  // bodyB が null の場合は固定点 anchor に接続
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

  addSpring(a, b, anchor, restLength, stiffness, damping) {
    const s = new Spring(a, b, anchor, restLength, stiffness, damping);
    this.springs.push(s);
    return s;
  }

  removeBody(body) {
    this.bodies = this.bodies.filter((b) => b !== body);
    this.constraints = this.constraints.filter((c) => c.a !== body && c.b !== body);
    this.springs = this.springs.filter((s) => s.a !== body && s.b !== body);
  }

  addEmitter(opts) {
    const e = new Emitter(opts);
    this.emitters.push(e);
    return e;
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
      this.solveCollisions();
      if (this.walls) this.solveWalls();
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
      if (b.isStatic) continue;
      b.force.y += this.gravity * b.mass;
      b.force.x += this.wind * b.mass;
      if (this.airDrag > 0) {
        b.force.x -= b.vel.x * this.airDrag * b.mass;
        b.force.y -= b.vel.y * this.airDrag * b.mass;
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
        const distSq = Math.max(d.x * d.x + d.y * d.y, 100); // 特異点回避
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
      if (b.isStatic) continue;
      b.vel.x += b.force.x * b.invMass * dt;
      b.vel.y += b.force.y * b.invMass * dt;
    }
  }

  integratePositions(dt) {
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
    }
  }

  solveConstraintVelocities() {
    for (const c of this.constraints) {
      const p2 = c.b ? c.b.pos : c.anchor;
      const n = Vec.normalize(Vec.sub(p2, c.a.pos));
      const v2 = c.b ? c.b.vel : { x: 0, y: 0 };
      const relVel = Vec.dot(Vec.sub(v2, c.a.vel), n);
      const invMassSum = c.a.invMass + (c.b ? c.b.invMass : 0);
      if (invMassSum === 0) continue;
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
      const d = Vec.sub(p2, c.a.pos);
      const dist = Vec.len(d);
      if (dist < 1e-9) continue;
      const n = Vec.scale(d, 1 / dist);
      const error = dist - c.length;
      const invMassSum = c.a.invMass + (c.b ? c.b.invMass : 0);
      if (invMassSum === 0) continue;
      const corr = error / invMassSum;
      c.a.pos.x += corr * c.a.invMass * n.x;
      c.a.pos.y += corr * c.a.invMass * n.y;
      if (c.b) {
        c.b.pos.x -= corr * c.b.invMass * n.x;
        c.b.pos.y -= corr * c.b.invMass * n.y;
      }
    }
  }

  solveCollisions() {
    const n = this.bodies.length;
    if (n < 40) {
      // 少数なら総当たりで十分
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          this.resolvePair(this.bodies[i], this.bodies[j]);
        }
      }
      return;
    }
    // 空間ハッシュ: セルサイズは最大半径に追従
    let maxR = 8;
    for (const b of this.bodies) if (b.radius > maxR) maxR = b.radius;
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
            if (other.id <= b.id) continue; // 各ペア1回だけ
            this.resolvePair(b, other);
          }
        }
      }
    }
  }

  resolvePair(a, b) {
    const invMassSum = a.invMass + b.invMass;
    if (invMassSum === 0) return;
    if (a.noCollide && b.noCollide && a.group === b.group) return;
    const d = Vec.sub(b.pos, a.pos);
    const dist = Vec.len(d);
    const minDist = a.radius + b.radius;
    if (dist >= minDist || dist < 1e-9) return;

    const nrm = Vec.scale(d, 1 / dist);
    // 位置補正(めり込み解消)
    const penetration = minDist - dist;
    const corr = (penetration / invMassSum) * 0.8;
    a.pos.x -= corr * a.invMass * nrm.x;
    a.pos.y -= corr * a.invMass * nrm.y;
    b.pos.x += corr * b.invMass * nrm.x;
    b.pos.y += corr * b.invMass * nrm.y;

    // 法線方向インパルス
    const relVel = Vec.sub(b.vel, a.vel);
    const velAlongNormal = Vec.dot(relVel, nrm);
    if (velAlongNormal > 0) return; // 離れつつある
    const e = Math.min(this.restitutionOf(a), this.restitutionOf(b));
    const jn = (-(1 + e) * velAlongNormal) / invMassSum;
    a.vel.x -= jn * a.invMass * nrm.x;
    a.vel.y -= jn * a.invMass * nrm.y;
    b.vel.x += jn * b.invMass * nrm.x;
    b.vel.y += jn * b.invMass * nrm.y;

    // 接線方向(摩擦)
    const tangent = { x: -nrm.y, y: nrm.x };
    const relVel2 = Vec.sub(b.vel, a.vel);
    const velAlongTangent = Vec.dot(relVel2, tangent);
    const mu = Math.max(a.friction, b.friction);
    const jt = Math.max(-mu * jn, Math.min(mu * jn, -velAlongTangent / invMassSum));
    a.vel.x -= jt * a.invMass * tangent.x;
    a.vel.y -= jt * a.invMass * tangent.y;
    b.vel.x += jt * b.invMass * tangent.x;
    b.vel.y += jt * b.invMass * tangent.y;
  }

  solveWalls() {
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      const e = this.restitutionOf(b);
      const r = b.radius;
      if (b.pos.x - r < 0) {
        b.pos.x = r;
        if (b.vel.x < 0) b.vel.x = -b.vel.x * e;
      } else if (b.pos.x + r > this.width) {
        b.pos.x = this.width - r;
        if (b.vel.x > 0) b.vel.x = -b.vel.x * e;
      }
      if (b.pos.y - r < 0) {
        b.pos.y = r;
        if (b.vel.y < 0) b.vel.y = -b.vel.y * e;
      } else if (b.pos.y + r > this.height) {
        b.pos.y = this.height - r;
        if (b.vel.y > 0) {
          b.vel.y = -b.vel.y * e;
          // 床での転がり摩擦
          b.vel.x *= 1 - Math.min(b.friction * 2, 0.5);
        }
      }
    }
  }

  updateTrails() {
    for (const b of this.bodies) {
      if (!b.trail) continue;
      b.trail.push({ x: b.pos.x, y: b.pos.y });
      if (b.trail.length > this.maxTrail) b.trail.shift();
    }
  }

  // 運動エネルギー合計(表示用)
  kineticEnergy() {
    let ke = 0;
    for (const b of this.bodies) {
      if (b.isStatic) continue;
      ke += 0.5 * b.mass * (b.vel.x * b.vel.x + b.vel.y * b.vel.y);
    }
    return ke;
  }

  bodyAt(x, y) {
    // 上に描画されているもの(配列の後ろ)を優先
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const b = this.bodies[i];
      const dx = b.pos.x - x, dy = b.pos.y - y;
      if (dx * dx + dy * dy <= (b.radius + 5) * (b.radius + 5)) return b;
    }
    return null;
  }
}

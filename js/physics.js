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
    this.gravity = 500;            // px/s^2(下向き)
    this.mutualGravity = false;    // 惑星軌道モード
    this.mutualG = 8000;           // 万有引力定数(px単位系)
    this.walls = true;             // 画面端で反射するか
    this.globalRestitution = null; // nullなら各Bodyの値を使う
    this.airDrag = 0;              // 空気抵抗係数
    this.iterations = 10;          // コンストレイント/衝突の反復回数
    this.maxTrail = 400;
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

  clear() {
    this.bodies = [];
    this.constraints = [];
    this.springs = [];
  }

  restitutionOf(body) {
    return this.globalRestitution ?? body.restitution;
  }

  step(dt) {
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
  }

  applyForces(dt) {
    for (const b of this.bodies) {
      b.force.x = 0;
      b.force.y = 0;
      if (b.isStatic) continue;
      b.force.y += this.gravity * b.mass;
      if (this.airDrag > 0) {
        b.force.x -= b.vel.x * this.airDrag * b.mass;
        b.force.y -= b.vel.y * this.airDrag * b.mass;
      }
    }
    if (this.mutualGravity) this.applyMutualGravity();
    for (const s of this.springs) this.applySpring(s);
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
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        this.resolvePair(this.bodies[i], this.bodies[j]);
      }
    }
  }

  resolvePair(a, b) {
    const invMassSum = a.invMass + b.invMass;
    if (invMassSum === 0) return;
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

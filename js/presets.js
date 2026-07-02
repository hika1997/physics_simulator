'use strict';

/** シーンプリセット定義。各関数は world を初期状態に組み立てる。 */

const PALETTE = ['#4a9eff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff', '#ff9e6d', '#5ee6eb'];

function pick(i) {
  return PALETTE[i % PALETTE.length];
}

const PRESETS = {
  balls: {
    name: 'ボール落下',
    description: 'クリックでボールを追加、ドラッグで投げられます',
    setup(world) {
      world.gravity = 500;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0;
      for (let i = 0; i < 12; i++) {
        world.addBody({
          x: 60 + Math.random() * (world.width - 120),
          y: 40 + Math.random() * (world.height * 0.4),
          vx: (Math.random() - 0.5) * 300,
          vy: (Math.random() - 0.5) * 100,
          radius: 12 + Math.random() * 22,
          restitution: 0.85,
          color: pick(i),
        });
      }
    },
  },

  pendulum: {
    name: '多重振り子',
    description: 'おもりをドラッグして揺らしてみてください',
    setup(world) {
      world.gravity = 500;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0.02;
      const cx = world.width / 2;
      const topY = 60;
      // 3連振り子
      let prev = null;
      for (let i = 0; i < 3; i++) {
        const b = world.addBody({
          x: cx + (i + 1) * 70,
          y: topY,
          radius: 14 + i * 2,
          restitution: 0.5,
          color: pick(i),
          trail: i === 2,
        });
        if (prev) world.addConstraint(b, prev);
        else world.addConstraint(b, null, { x: cx, y: topY });
        prev = b;
      }
      // 単振り子(比較用)
      const single = world.addBody({
        x: cx - 220, y: topY + 40,
        radius: 18, restitution: 0.5, color: pick(4),
      });
      world.addConstraint(single, null, { x: cx - 300, y: topY });
    },
  },

  cradle: {
    name: 'ニュートンのゆりかご',
    description: '端の球をドラッグして持ち上げ、離すと運動量が伝わります',
    setup(world) {
      world.gravity = 800;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0;
      world.iterations = 20;
      const n = 5;
      const r = 20;
      const topY = 80;
      const ropeLen = 220;
      const cx = world.width / 2 - (n - 1) * r;
      for (let i = 0; i < n; i++) {
        const x = cx + i * r * 2;
        const b = world.addBody({
          x: i === 0 ? x - ropeLen * 0.7 : x,
          y: i === 0 ? topY + ropeLen * 0.55 : topY + ropeLen,
          radius: r,
          restitution: 0.98,
          friction: 0,
          color: pick(i),
        });
        world.addConstraint(b, null, { x, y: topY }, ropeLen);
      }
    },
  },

  orbit: {
    name: '惑星軌道',
    description: '中央の恒星のまわりを惑星が公転します(万有引力)',
    setup(world) {
      world.gravity = 0;
      world.walls = false;
      world.mutualGravity = true;
      world.airDrag = 0;
      const cx = world.width / 2, cy = world.height / 2;
      const star = world.addBody({
        x: cx, y: cy, radius: 26, mass: 400,
        color: '#ffd166', isStatic: true,
      });
      const orbits = [
        { r: 90, radius: 6, color: pick(0) },
        { r: 150, radius: 9, color: pick(1) },
        { r: 220, radius: 11, color: pick(3) },
        { r: 310, radius: 8, color: pick(4) },
      ];
      for (const o of orbits) {
        const v = Math.sqrt((world.mutualG * star.mass) / o.r); // 円軌道速度
        const angle = Math.random() * Math.PI * 2;
        world.addBody({
          x: cx + Math.cos(angle) * o.r,
          y: cy + Math.sin(angle) * o.r,
          vx: -Math.sin(angle) * v,
          vy: Math.cos(angle) * v,
          radius: o.radius,
          mass: 0.5,
          color: o.color,
          trail: true,
        });
      }
    },
  },

  billiards: {
    name: 'ビリヤード',
    description: '白球をドラッグして弾き、ラックを崩してください',
    setup(world) {
      world.gravity = 0;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0.6; // 台の転がり抵抗
      const r = 14;
      const cx = world.width * 0.68, cy = world.height / 2;
      let i = 0;
      for (let row = 0; row < 5; row++) {
        for (let k = 0; k <= row; k++) {
          world.addBody({
            x: cx + row * (r * 2 - 1) * 0.87,
            y: cy + (k - row / 2) * (r * 2 + 0.5),
            radius: r,
            restitution: 0.95,
            friction: 0.02,
            color: pick(i++),
          });
        }
      }
      world.addBody({
        x: world.width * 0.2, y: cy,
        radius: r, restitution: 0.95, friction: 0.02,
        color: '#f5f5f5',
      });
    },
  },

  springs: {
    name: 'バネ連結',
    description: 'ボールをドラッグするとバネが伸び縮みします',
    setup(world) {
      world.gravity = 400;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0.05;
      const cx = world.width / 2;
      // 天井から吊るしたバネのチェーン
      let prev = null;
      for (let i = 0; i < 4; i++) {
        const b = world.addBody({
          x: cx + i * 10, y: 120 + i * 80,
          radius: 14, restitution: 0.5, color: pick(i),
        });
        if (prev) world.addSpring(b, prev, null, 70, 80, 3);
        else world.addSpring(b, null, { x: cx, y: 40 }, 70, 80, 3);
        prev = b;
      }
      // 三角形に組んだバネ構造(ソフトボディ風)
      const tx = cx - 250, ty = world.height * 0.4;
      const tri = [];
      const pts = [
        { x: tx, y: ty }, { x: tx + 90, y: ty }, { x: tx + 45, y: ty - 78 },
      ];
      for (let i = 0; i < 3; i++) {
        tri.push(world.addBody({
          x: pts[i].x, y: pts[i].y,
          radius: 12, restitution: 0.6, color: pick(i + 4),
        }));
      }
      for (let i = 0; i < 3; i++) {
        world.addSpring(tri[i], tri[(i + 1) % 3], null, null, 200, 4);
      }
    },
  },
};

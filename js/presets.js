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

  dominoes: {
    name: 'ドミノ倒し',
    description: '振り子の球が最初のドミノを倒します。ドラッグで並べ替えも',
    setup(world) {
      world.gravity = 900;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0;
      world.iterations = 14;
      const floor = world.height;
      const n = Math.min(14, Math.floor((world.width - 260) / 52));
      const x0 = world.width * 0.22;
      for (let i = 0; i < n; i++) {
        world.addBody({
          shape: 'box', w: 13, h: 78,
          x: x0 + i * 52, y: floor - 39,
          restitution: 0.05, friction: 0.5,
          color: pick(i),
        });
      }
      // 振り子の球: 最下点でちょうど最初のドミノの上部に当たる長さにする
      const anchor = { x: x0, y: 60 };
      const L = (floor - 60) - 60; // 最下点の球中心 = ドミノ上部付近
      const swing = 1.1; // 引き上げ角(ラジアン)
      const ball = world.addBody({
        x: anchor.x - Math.sin(swing) * L,
        y: anchor.y + Math.cos(swing) * L,
        radius: 24, mass: 40,
        restitution: 0.2, friction: 0.2,
        color: '#6b7280',
      });
      world.addConstraint(ball, null, anchor, L);
    },
  },

  tower: {
    name: '積み木タワー',
    description: 'ボールを投げて塔を崩してください(タップでボール追加)',
    setup(world) {
      world.gravity = 900;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0;
      world.iterations = 16;
      const floor = world.height;
      const bw = 52, bh = 26;
      const cx = world.width * 0.62;
      // ピラミッド型(上ほど狭い)にすると外側のブロックも下から支えられて安定する
      const counts = [5, 4, 4, 3, 3, 2, 2, 1];
      for (let r = 0; r < counts.length; r++) {
        const count = counts[r];
        for (let k = 0; k < count; k++) {
          const off = (k - (count - 1) / 2) * bw;
          world.addBody({
            shape: 'box', w: bw - 2, h: bh,
            // 生成時のめり込みによるガタつきを防ぐため僅かに隙間を空けて積む
            x: cx + off, y: floor - bh / 2 - r * (bh + 1) - 1,
            restitution: 0.05, friction: 0.55,
            color: pick(r),
          });
        }
      }
    },
  },

  ramps: {
    name: '斜面と風車',
    description: 'ボールが斜面を転がり、シーソーと風車に当たります',
    setup(world) {
      world.gravity = 700;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0.02;
      world.iterations = 12;
      const W = world.width, H = world.height;
      // ジグザグの静的斜面
      world.addBody({
        shape: 'box', w: W * 0.5, h: 14,
        x: W * 0.25, y: H * 0.25, angle: 0.22,
        isStatic: true, restitution: 0.1, friction: 0.3, color: '#3a4358',
      });
      world.addBody({
        shape: 'box', w: W * 0.45, h: 14,
        x: W * 0.72, y: H * 0.5, angle: -0.24,
        isStatic: true, restitution: 0.1, friction: 0.3, color: '#3a4358',
      });
      // シーソー(中心をピン留め、回転自由)
      const seesaw = world.addBody({
        shape: 'box', w: 240, h: 12,
        x: W * 0.3, y: H - 90,
        restitution: 0.2, friction: 0.5, color: '#8b6f47',
      });
      world.addPin(seesaw, { x: W * 0.3, y: H - 90 });
      world.addBody({ // 支柱(飾り)
        shape: 'box', w: 14, h: 60,
        x: W * 0.3, y: H - 30,
        isStatic: true, restitution: 0.1, friction: 0.3, color: '#3a4358',
      });
      // 風車(モーター定速回転)
      world.addBody({
        shape: 'box', w: 190, h: 12,
        x: W * 0.68, y: H - 130,
        isStatic: true, motor: 1.6,
        restitution: 0.4, friction: 0.2, color: '#c77dff',
      });
      // 上からボールを供給
      world.addEmitter({
        x: 40, y: 30, rate: 1.2,
        speed: 120, angle: 0.25, spread: 0.1,
        radius: 13, radiusJitter: 6,
        lifetime: 30, maxAlive: 26,
        colors: PALETTE,
      });
    },
  },

  chaos: {
    name: '二重振り子カオス',
    description: 'ほぼ同じ初期条件の2つの振り子が、やがて全く違う軌道に',
    setup(world) {
      world.gravity = 600;
      world.walls = false;
      world.mutualGravity = false;
      world.airDrag = 0;
      world.iterations = 20;
      const anchor = { x: world.width / 2, y: world.height * 0.32 };
      const L = Math.min(120, world.height * 0.2);
      const start = Math.PI * 0.9; // ほぼ真上から
      const configs = [
        { offset: 0, color: '#4a9eff' },
        { offset: 0.005, color: '#ff6b6b' }, // わずか0.005ラジアンの差
      ];
      for (const cfg of configs) {
        const a1 = start + cfg.offset;
        const b1 = world.addBody({
          x: anchor.x + Math.sin(a1) * L,
          y: anchor.y + Math.cos(a1) * L,
          radius: 11, mass: 3,
          restitution: 0.5,
          color: cfg.color,
          noCollide: true, group: 9, // 振り子同士は衝突させない
        });
        world.addConstraint(b1, null, anchor, L);
        const b2 = world.addBody({
          x: b1.pos.x + Math.sin(a1) * L,
          y: b1.pos.y + Math.cos(a1) * L,
          radius: 11, mass: 3,
          restitution: 0.5,
          color: cfg.color,
          trail: true,
          noCollide: true, group: 9,
        });
        world.addConstraint(b2, b1, null, L);
      }
    },
  },

  cloth: {
    name: '布シミュレーション',
    description: '布をドラッグしたり、風スライダーでなびかせてみてください',
    setup(world) {
      world.gravity = 500;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0.4;
      world.iterations = 12;
      const cols = 16, rows = 10;
      const spacing = Math.min(24, (world.width * 0.6) / cols);
      const x0 = world.width / 2 - (cols * spacing) / 2;
      const y0 = 60;
      const grid = [];
      for (let r = 0; r < rows; r++) {
        grid.push([]);
        for (let c = 0; c < cols; c++) {
          const pinned = r === 0 && c % 3 === 0;
          const b = world.addBody({
            x: x0 + c * spacing, y: y0 + r * spacing,
            radius: 4, mass: 0.3,
            restitution: 0.1, friction: 0.2,
            color: pick(r % 2 === 0 ? 0 : 6),
            isStatic: pinned,
            noCollide: true, group: 1,
          });
          grid[r].push(b);
          if (c > 0) world.addConstraint(b, grid[r][c - 1], null, spacing);
          if (r > 0) world.addConstraint(b, grid[r - 1][c], null, spacing);
        }
      }
    },
  },

  galton: {
    name: 'ガルトンボード',
    description: '玉が釘に当たって落ち、山なりの分布(二項分布)ができます',
    setup(world) {
      world.gravity = 700;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0.1;
      const cx = world.width / 2;
      const pegR = 5, ballR = 6;
      const dx = 44, dy = 40;
      const rows = Math.min(9, Math.floor((world.height * 0.45) / dy));
      const topY = 120;
      // 釘(三角形配置)
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k <= r; k++) {
          world.addBody({
            x: cx + (k - r / 2) * dx,
            y: topY + r * dy,
            radius: pegR, isStatic: true,
            restitution: 0.5, color: '#5a6478',
          });
        }
      }
      // 仕切り(静的な円の柱で表現)
      const binTop = topY + rows * dy + 30;
      const nBins = rows + 2;
      for (let i = 0; i <= nBins; i++) {
        const x = cx + (i - nBins / 2) * dx;
        for (let y = binTop; y < world.height - 8; y += 12) {
          world.addBody({ x, y, radius: 4, isStatic: true, restitution: 0.1, color: '#3a4358' });
        }
      }
      // 外壁: 横に飛び出した玉を受け止める(上に向かってすぼまる漏斗状)
      const wallX = (nBins / 2) * dx;
      for (let y = binTop - 12; y > 60; y -= 12) {
        const t = (binTop - y) / (binTop - 60); // 0(下)→1(上)
        const inset = t * (wallX - dx * 0.8);
        world.addBody({ x: cx - wallX + inset, y, radius: 4, isStatic: true, restitution: 0.1, color: '#3a4358' });
        world.addBody({ x: cx + wallX - inset, y, radius: 4, isStatic: true, restitution: 0.1, color: '#3a4358' });
      }
      // 上から玉を投入
      world.addEmitter({
        x: cx, y: 40, rate: 6,
        speed: 30, angle: Math.PI / 2, spread: 0.25,
        radius: ballR, radiusJitter: 0,
        lifetime: 60, maxAlive: 220,
        colors: PALETTE,
      });
    },
  },

  fountain: {
    name: '噴水',
    description: 'パーティクルの噴水。風スライダーで流れが変わります',
    setup(world) {
      world.gravity = 700;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0.05;
      world.iterations = 4; // 粒子多数なので軽めに
      world.addEmitter({
        x: world.width / 2, y: world.height - 30,
        rate: 45, speed: 950, angle: -Math.PI / 2, spread: 0.35,
        radius: 4, radiusJitter: 4,
        lifetime: 5, maxAlive: 300,
        colors: ['#4a9eff', '#5ee6eb', '#c77dff', '#f5f5f5'],
      });
      world.addEmitter({
        x: world.width * 0.2, y: world.height - 30,
        rate: 18, speed: 750, angle: -Math.PI / 2 + 0.25, spread: 0.2,
        radius: 4, radiusJitter: 3,
        lifetime: 5, maxAlive: 120,
        colors: ['#ffd166', '#ff9e6d'],
      });
      world.addEmitter({
        x: world.width * 0.8, y: world.height - 30,
        rate: 18, speed: 750, angle: -Math.PI / 2 - 0.25, spread: 0.2,
        radius: 4, radiusJitter: 3,
        lifetime: 5, maxAlive: 120,
        colors: ['#06d6a0', '#5ee6eb'],
      });
    },
  },

  bridge: {
    name: 'ロープ橋',
    description: '吊り橋の上にボールを落としてみてください(クリックで追加)',
    setup(world) {
      world.gravity = 500;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0.05;
      world.iterations = 15;
      const n = 17;
      const y = world.height * 0.45;
      const x0 = world.width * 0.12, x1 = world.width * 0.88;
      let prev = null;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const b = world.addBody({
          x: x0 + (x1 - x0) * t,
          y: y + Math.sin(t * Math.PI) * 20,
          radius: 7, mass: 2,
          restitution: 0.2, friction: 0.4,
          color: '#8b6f47',
        });
        if (prev) world.addConstraint(b, prev);
        else world.addConstraint(b, null, { x: x0 - 30, y });
        prev = b;
      }
      world.addConstraint(prev, null, { x: x1 + 30, y });
      // 橋の上に最初のボールを1個
      world.addBody({
        x: world.width / 2, y: y - 150,
        radius: 22, restitution: 0.3, color: pick(1),
      });
    },
  },

  wrecking: {
    name: '破壊球',
    description: '重い鉄球をドラッグして持ち上げ、離してピラミッドを崩してください',
    setup(world) {
      world.gravity = 800;
      world.walls = true;
      world.mutualGravity = false;
      world.airDrag = 0;
      world.iterations = 14;
      // ボールのピラミッド
      const r = 16;
      const baseY = world.height - r;
      const cx = world.width * 0.68;
      const layers = 7;
      let i = 0;
      for (let row = 0; row < layers; row++) {
        const count = layers - row;
        for (let k = 0; k < count; k++) {
          world.addBody({
            x: cx + (k - (count - 1) / 2) * (r * 2 + 1),
            y: baseY - row * (r * 2 - 2),
            radius: r, restitution: 0.15, friction: 0.4,
            color: pick(i++),
          });
        }
      }
      // 鉄球(重い・ロープ吊り)
      const anchor = { x: world.width * 0.35, y: 40 };
      const ball = world.addBody({
        x: world.width * 0.12, y: 200,
        radius: 34, mass: 120,
        restitution: 0.2, friction: 0.1,
        color: '#6b7280',
      });
      world.addConstraint(ball, null, anchor);
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

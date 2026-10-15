// ArkFights battle camera: the official Arknights stage perspective.
// Camera / projection / pickTile / tileQuad adapted from
// sganggs/Stronghold-Protocol@488db49f11daf862b67ce26fa4cf89aa6cba2466
// public/js/render/projection.js (GPL-3.0-or-later); adapted parts stay GPL-3.0-or-later.
// World space: x = col, y = row (row 0 nearest the camera side), z = height in tiles.
(function () {
  "use strict";

  const DEG = Math.PI / 180;

  // Arknights' standard battle camera (fovY 40°, pitch 30°) + configBlackBoard params.
  const OFFICIAL = {
    base: [0, -4.81, -7.76],
    pitch: 30,
    fovY: 40,
  };
  const PARAMS = {
    left_battle: [-4, 1.91, -0.6],
    right_battle: [4, 1.91, -0.6],
    mid_battle: [0, 0, -4.22],
    enemy: [0, 7.86, 0.9],
  };

  class Camera {
    constructor(target, position, fovY, options) {
      this.t = target;
      this.p = position;
      this.fovY = fovY;
      this.viewport = viewportFor(options && options.viewport);
      this.verticalRight = (options && options.verticalRight) || [1, 0, 0];
      this.update();
    }

    update() {
      const f = [this.t[0] - this.p[0], this.t[1] - this.p[1], this.t[2] - this.p[2]];
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      this.fwd = f.map((v) => v / fl);
      // 正交基：right = fwd × worldUp，up = right × fwd（相机无滚转）
      const worldUp = [0, 0, 1];
      this.right = [
        this.fwd[1] * worldUp[2] - this.fwd[2] * worldUp[1],
        this.fwd[2] * worldUp[0] - this.fwd[0] * worldUp[2],
        this.fwd[0] * worldUp[1] - this.fwd[1] * worldUp[0],
      ];
      const rl = Math.hypot(this.right[0], this.right[1], this.right[2]);
      // A straight-down camera has no horizontal forward component. Keep an
      // explicit side basis so top view stays invertible for both players.
      this.right = rl < 1e-8 ? this.verticalRight.slice() : this.right.map((v) => v / rl);
      this.up = [
        this.right[1] * this.fwd[2] - this.right[2] * this.fwd[1],
        this.right[2] * this.fwd[0] - this.right[0] * this.fwd[2],
        this.right[0] * this.fwd[1] - this.right[1] * this.fwd[0],
      ];
      this.dist = fl;
    }

    project(x, y, z, out) {
      out = out || { x: 0, y: 0, s: 0, depth: 0 };
      const v = [x - this.p[0], y - this.p[1], z - this.p[2]];
      const depth = v[0] * this.fwd[0] + v[1] * this.fwd[1] + v[2] * this.fwd[2];
      const vx = v[0] * this.right[0] + v[1] * this.right[1] + v[2] * this.right[2];
      const vy = v[0] * this.up[0] + v[1] * this.up[1] + v[2] * this.up[2];
      const vp = this.viewport;
      const f = (vp.height / 2) / Math.tan(this.fovY * DEG / 2);
      out.x = vp.x + vp.width / 2 + f * vx / depth;
      out.y = vp.y + vp.height / 2 - f * vy / depth;
      out.s = f / depth;
      out.depth = depth;
      return out;
    }

    unproject(sx, sy, z, out) {
      out = out || { x: 0, y: 0 };
      const vp = this.viewport;
      const f = (vp.height / 2) / Math.tan(this.fovY * DEG / 2);
      const dx = (sx - vp.x - vp.width / 2) / f;
      const dy = -(sy - vp.y - vp.height / 2) / f;
      const dir = [
        this.fwd[0] + dx * this.right[0] + dy * this.up[0],
        this.fwd[1] + dx * this.right[1] + dy * this.up[1],
        this.fwd[2] + dx * this.right[2] + dy * this.up[2],
      ];
      if (Math.abs(dir[2]) < 1e-9) return null;
      const k = (z - this.p[2]) / dir[2];
      if (k <= 0) return null;
      out.x = this.p[0] + dir[0] * k;
      out.y = this.p[1] + dir[1] * k;
      return out;
    }
  }

  const view = { w: 960, h: 640 };
  function setViewport(w, h) {
    if (Number.isFinite(w) && w > 0) view.w = w;
    if (Number.isFinite(h) && h > 0) view.h = h;
  }

  function viewportFor(vp) {
    vp = vp || {};
    const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
    const x = Math.max(0, Math.min(view.w - 1, finite(vp.x, finite(vp.left, 0))));
    const y = Math.max(0, Math.min(view.h - 1, finite(vp.y, finite(vp.top, 0))));
    return {
      x, y,
      width: Math.max(1, Math.min(view.w - x, finite(vp.width, view.w - x))),
      height: Math.max(1, Math.min(view.h - y, finite(vp.height, view.h - y))),
    };
  }

  const PRESETS = {
    default: { elevation: 58, lateral: 0.075 },
    top: { elevation: 90, lateral: 0 },
    angled: { elevation: 46, lateral: 0.11 },
  };

  // Camera for a player's own side — blue sees from the blue side, red mirrored,
  // exactly like the two battle cameras of the original stage view.
  // 与原作一致：镜头高位俯视（仰角约 58°，接近原作 30° pitch from straight down）。
  function cameraFor(team, cols, rows, options) {
    options = options || {};
    const vp = viewportFor(options.viewport);
    const name = Object.prototype.hasOwnProperty.call(PRESETS, options.preset) ? options.preset : "default";
    const preset = PRESETS[name];
    const target = [(cols - 1) / 2, (rows - 1) / 2, 0.25];
    const elev = preset.elevation * DEG;
    const s = team === "red" ? -1 : 1;
    const make = (dist, fovY) => new Camera(target.slice(), [
      target[0] + s * dist * preset.lateral,
      target[1] - s * dist * Math.cos(elev),
      target[2] + dist * Math.sin(elev),
    ], fovY || OFFICIAL.fovY, { viewport: vp, verticalRight: [s, 0, 0] });
    const focal = (vp.height / 2) / Math.tan(OFFICIAL.fovY * DEG / 2);
    const minTile = Number.isFinite(options.minTilePixels) && options.minTilePixels > 0 ? options.minTilePixels : 44;
    const fit = options.fit === true || (options.fit !== false && cols <= 18 && rows <= 14);
    let distance = Math.max(7, focal / minTile);
    let fitClamped = false;
    if (fit) {
      // Fit the complete small field, including the elevated surface and the
      // standing models above it. HUD panels are excluded by the viewport.
      const margin = Math.min(12, vp.width * 0.025, vp.height * 0.025);
      const fits = (dist) => {
        const cam = make(dist);
        for (const x of [-0.5, cols - 0.5]) {
          for (const y of [-0.5, rows - 0.5]) {
            for (const z of [0, 2.2]) {
              const p = cam.project(x, y, z);
              if (p.depth <= 0 || p.x < vp.x + margin || p.x > vp.x + vp.width - margin ||
                  p.y < vp.y + margin || p.y > vp.y + vp.height - margin) return false;
            }
          }
        }
        return true;
      };
      let low = 3;
      let high = Math.max(15.5, distance);
      while (!fits(high) && high < 4096) high *= 2;
      for (let i = 0; i < 28; i++) {
        const mid = (low + high) / 2;
        if (fits(mid)) high = mid;
        else low = mid;
      }
      distance = high;
      // 格子可辨度下限：整图收纳不得把格子缩到看不清（默认 ≈22px）。触底时放弃继续拉远，
      // 按可辨度取景（此时整图不完全可见，可平移补看）——全图要求=保持格子可辨度。
      const floor = Number.isFinite(options.minTileFloor) && options.minTileFloor > 0 ? options.minTileFloor : 22;
      if (focal / distance < floor) {
        distance = focal / floor;
        fitClamped = true;
      }
    }
    let fovY = OFFICIAL.fovY;
    if (!fit) {
      // A large field may extend past a close perspective camera, especially
      // in a short window. Keep its complete depth in front of the camera and
      // narrow the lens instead; readable tile scale and pan remain unchanged.
      const depthSpan = Math.abs(preset.lateral) * (cols - 1) / 2 +
        Math.cos(elev) * (rows - 1) / 2 + Math.sin(elev) * 2.2;
      distance = Math.max(distance, depthSpan * 3);
      fovY = 2 * Math.atan(vp.height / (2 * distance * minTile)) / DEG;
    }
    const cam = make(distance, fovY);
    cam.preset = name;
    cam.fullMapVisible = fit && !fitClamped;
    return cam;
  }

  function pickTile(cam, sx, sy, heightAt, rows, cols) {
    // 多高度层：取相机最近的有效命中（高台在前则高台遮挡平地，反之亦然）
    let best = null;
    let bestDist = Infinity;
    for (const z of [1, 0]) {
      const p = cam.unproject(sx, sy, z);
      if (!p) continue;
      const col = Math.floor(p.x + 0.5);
      const row = Math.floor(p.y + 0.5);
      if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
      if ((heightAt(col, row) || 0) !== z) continue;
      const d = Math.hypot(p.x - cam.p[0], p.y - cam.p[1], z - cam.p[2]);
      if (d < bestDist) {
        bestDist = d;
        best = { x: col, y: row };
      }
    }
    return best;
  }

  function tileQuad(cam, col, row, z, inset) {
    const a = 0.5 - (inset || 0.03);
    return [
      cam.project(col - a, row - a, z),
      cam.project(col + a, row - a, z),
      cam.project(col + a, row + a, z),
      cam.project(col - a, row + a, z),
    ];
  }

  window.AKF_PROJECTION = {
    DEG,
    OFFICIAL,
    PARAMS,
    PRESETS,
    Camera,
    setViewport,
    cameraFor,
    pickTile,
    tileQuad,
    view,
  };
})();

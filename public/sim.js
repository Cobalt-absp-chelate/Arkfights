// ArkFights authoritative battle simulation (server-裁定; browser may preview it too).
// Shared by server.js (require) and the browser (window.AKF_SIM).
// Damage: original mechanics first (physical = atk - def; arts = atk × (1 - res/100)),
// then the final damage multiplier (dmgScale) applies to damage only; healing is raw.
(function (root) {
  "use strict";

  // 按名查表一律只认**自有键**（Object.prototype.hasOwnProperty）：杜绝 "toString"/"constructor"/"__proto__"
  // 经原型链被误认成合法值（dir 查表 / 地图查表 / 部署区查表全覆盖）
  const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

  // 地图定义：0 地面 / 1 高台 / 2 高台踏板 / 3 障碍 / 4 通路
  // 尺寸/门/部署半场/初始部署区全部出自地图配置（public/maps.js）；无 16/12/7/8 等全局硬编码
  function makeMap(id, name, rows, gates, half, zones) {
    const grid = rows.map((row) => row.split("").map((ch) => Number(ch)));
    const height = grid.length;
    const width = grid[0] ? grid[0].length : 0;
    const at = (x, y) => (x >= 0 && x < width && y >= 0 && y < height ? grid[y][x] : 3);
    const halfX = Number.isInteger(half) ? half : Math.floor((width - 1) / 2);
    const initZones = (zones && zones.initialDeploy) || null;
    return {
      id,
      name,
      grid,
      width,
      height,
      half: halfX,
      zones: zones || null,
      gates: gates || {
        blue: [{ x: 0, y: Math.floor(height / 2) }],
        red: [{ x: width - 1, y: Math.floor(height / 2) }],
      },
      // 地形语义（唯一真源，渲染/部署/移动全部由此派生）：
      //   0 地面 / 1 高台（抬升，只有远程可部署）/ 2 地面通路（横穿高台的缺口，地面可走可部署）/ 3 障碍 / 4 通路
      // 注意：2 曾经同时被当作「高台」，导致地面单位被画到抬升地块上（路线像是踩高台）。
      //       2 的本质是穿过高台的缺口（地图说明里的「双通路横穿」「高台踏板」），因此按地面处理。
      isHigh: (x, y) => at(x, y) === 1,
      isPath: (x, y) => at(x, y) === 2 || at(x, y) === 4,
      isWall: (x, y) => at(x, y) === 3,
      routable: (x, y) => [0, 2, 4].includes(at(x, y)),
      groundDeploy: (x, y) => at(x, y) === 0 || at(x, y) === 2 || at(x, y) === 4,
      highDeploy: (x, y) => at(x, y) === 1,
      inHalf: (team, x) => (team === "blue" ? x <= halfX : x >= halfX + 1),
      // 初始部署区（zones.initialDeploy，与地图配置同源）：有配置=只认矩形内（含端点）；无配置回退整半场
      inInitialDeploy: (team, x, y) => {
        const rects = initZones && hasOwn(initZones, team) ? initZones[team] : null;
        if (!Array.isArray(rects) || !rects.length) return (team === "blue" ? x <= halfX : x >= halfX + 1);
        return rects.some((r) => r && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
      },
    };
  }

  // ---------------- 简化选路（线路制）：每图若干条完整进攻线路 ----------------
  // 线路 = 走廊折线（拐点序列，逐格展开）+ 绑定的敌目标门。部署默认走“部署点所在线路”，
  // 系统沿所选走廊推进处理岔路（寻路只把部署点/途经点与走廊用合法地形连接，
  // 不做全员最短路/绕敌/后撤/追出路线）；少量途经点仅作高级可选。
  // points = 蓝方进攻方向拐点；pointsRed = 红方进攻方向拐点（缺省 = 180° 旋转，仅当该向地形可走时采用）。
  const LINE_DEFS = {
    cross: [
      { id: "up", name: "上路", gate: { blue: { x: 15, y: 6 }, red: { x: 0, y: 6 } }, points: [{ x: 0, y: 5 }, { x: 15, y: 5 }] },
      { id: "down", name: "下路", gate: { blue: { x: 15, y: 6 }, red: { x: 0, y: 6 } }, points: [{ x: 0, y: 6 }, { x: 15, y: 6 }] },
      // 外环线：绕开中央高台的边缘环路（第三条可选线路；每图 ≥3 条）
      { id: "loop", name: "外环线", gate: { blue: { x: 15, y: 6 }, red: { x: 0, y: 6 } }, points: [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 5 }] },
    ],
    lanes: [
      { id: "up", name: "上线", gate: { blue: { x: 15, y: 3 }, red: { x: 0, y: 8 } }, points: [{ x: 0, y: 3 }, { x: 15, y: 3 }] },
      { id: "down", name: "下线", gate: { blue: { x: 15, y: 8 }, red: { x: 0, y: 3 } }, points: [{ x: 0, y: 8 }, { x: 15, y: 8 }] },
      // 外环线：沿底缘绕行接入下线门（第三条可选线路）
      { id: "loop", name: "外环线", gate: { blue: { x: 15, y: 8 }, red: { x: 0, y: 3 } }, points: [{ x: 0, y: 11 }, { x: 15, y: 11 }, { x: 15, y: 8 }] },
    ],
    training: [
      { id: "up", name: "上路", gate: { blue: { x: 11, y: 3 }, red: { x: 0, y: 4 } }, points: [{ x: 0, y: 3 }, { x: 11, y: 3 }] },
      { id: "down", name: "下路", gate: { blue: { x: 11, y: 4 }, red: { x: 0, y: 3 } }, points: [{ x: 0, y: 4 }, { x: 11, y: 4 }] },
      // 外环线：沿上缘绕行接入上路门（第三条可选线路；与 maps.json lines 镜像）
      { id: "loop", name: "外环线", gate: { blue: { x: 11, y: 3 }, red: { x: 0, y: 4 } }, points: [{ x: 0, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 3 }] },
    ],
    valley: [
      { id: "up", name: "上线", gate: { blue: { x: 23, y: 5 }, red: { x: 0, y: 10 } }, points: [{ x: 0, y: 5 }, { x: 23, y: 5 }] },
      { id: "down", name: "下线", gate: { blue: { x: 23, y: 10 }, red: { x: 0, y: 5 } }, points: [{ x: 0, y: 10 }, { x: 23, y: 10 }] },
      { id: "spine", name: "纵贯侧路", gate: { blue: { x: 23, y: 10 }, red: { x: 0, y: 5 } }, points: [{ x: 0, y: 5 }, { x: 12, y: 5 }, { x: 12, y: 10 }, { x: 23, y: 10 }] },
    ],
    citadel: [
      { id: "up", name: "上线", gate: { blue: { x: 23, y: 3 }, red: { x: 0, y: 14 } }, points: [{ x: 0, y: 3 }, { x: 23, y: 3 }] },
      {
        id: "mid", name: "中线", gate: { blue: { x: 23, y: 9 }, red: { x: 0, y: 9 } },
        points: [{ x: 0, y: 9 }, { x: 5, y: 9 }, { x: 5, y: 12 }, { x: 12, y: 12 }, { x: 12, y: 13 }, { x: 19, y: 13 }, { x: 19, y: 9 }, { x: 23, y: 9 }],
        pointsRed: [{ x: 23, y: 9 }, { x: 18, y: 9 }, { x: 18, y: 5 }, { x: 11, y: 5 }, { x: 11, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 9 }, { x: 0, y: 9 }],
      },
      { id: "down", name: "下线", gate: { blue: { x: 23, y: 14 }, red: { x: 0, y: 3 } }, points: [{ x: 0, y: 14 }, { x: 23, y: 14 }] },
    ],
    basin: [
      { id: "up", name: "上线", gate: { blue: { x: 27, y: 4 }, red: { x: 0, y: 15 } }, points: [{ x: 0, y: 4 }, { x: 27, y: 4 }] },
      { id: "down", name: "下线", gate: { blue: { x: 27, y: 15 }, red: { x: 0, y: 4 } }, points: [{ x: 0, y: 15 }, { x: 27, y: 15 }] },
      {
        id: "heartA", name: "穿心甲", gate: { blue: { x: 27, y: 15 }, red: { x: 0, y: 4 } },
        points: [{ x: 0, y: 4 }, { x: 13, y: 4 }, { x: 13, y: 15 }, { x: 27, y: 15 }],
        pointsRed: [{ x: 27, y: 15 }, { x: 13, y: 15 }, { x: 13, y: 4 }, { x: 0, y: 4 }],
      },
      {
        id: "heartB", name: "穿心乙", gate: { blue: { x: 27, y: 4 }, red: { x: 0, y: 15 } },
        points: [{ x: 0, y: 15 }, { x: 13, y: 15 }, { x: 13, y: 4 }, { x: 27, y: 4 }],
        pointsRed: [{ x: 27, y: 4 }, { x: 13, y: 4 }, { x: 13, y: 15 }, { x: 0, y: 15 }],
      },
    ],
    ridge: [
      { id: "flankN", name: "北侧翼", gate: { blue: { x: 31, y: 2 }, red: { x: 0, y: 17 } }, points: [{ x: 0, y: 2 }, { x: 31, y: 2 }] },
      { id: "up", name: "上长线", gate: { blue: { x: 31, y: 4 }, red: { x: 0, y: 15 } }, points: [{ x: 0, y: 4 }, { x: 31, y: 4 }] },
      {
        id: "cross", name: "越脊线", gate: { blue: { x: 31, y: 15 }, red: { x: 0, y: 4 } },
        points: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 15 }, { x: 31, y: 15 }],
        pointsRed: [{ x: 31, y: 15 }, { x: 16, y: 15 }, { x: 16, y: 4 }, { x: 0, y: 4 }],
      },
      { id: "down", name: "下长线", gate: { blue: { x: 31, y: 15 }, red: { x: 0, y: 4 } }, points: [{ x: 0, y: 15 }, { x: 31, y: 15 }] },
      { id: "flankS", name: "南侧翼", gate: { blue: { x: 31, y: 17 }, red: { x: 0, y: 2 } }, points: [{ x: 0, y: 17 }, { x: 31, y: 17 }] },
    ],
    frontier: [
      { id: "up", name: "上线", gate: { blue: { x: 31, y: 5 }, red: { x: 0, y: 18 } }, points: [{ x: 0, y: 5 }, { x: 31, y: 5 }] },
      { id: "mid", name: "中线", gate: { blue: { x: 31, y: 12 }, red: { x: 0, y: 12 } }, points: [{ x: 0, y: 12 }, { x: 31, y: 12 }] },
      {
        id: "spine", name: "纵贯路", gate: { blue: { x: 31, y: 18 }, red: { x: 0, y: 5 } },
        points: [{ x: 0, y: 5 }, { x: 16, y: 5 }, { x: 16, y: 18 }, { x: 31, y: 18 }],
        pointsRed: [{ x: 31, y: 18 }, { x: 15, y: 18 }, { x: 15, y: 5 }, { x: 0, y: 5 }],
      },
      { id: "down", name: "下线", gate: { blue: { x: 31, y: 18 }, red: { x: 0, y: 5 } }, points: [{ x: 0, y: 18 }, { x: 31, y: 18 }] },
      {
        id: "back", name: "底部绕后", gate: { blue: { x: 31, y: 18 }, red: { x: 0, y: 5 } },
        points: [{ x: 0, y: 21 }, { x: 28, y: 21 }, { x: 28, y: 18 }, { x: 31, y: 18 }],
        pointsRed: [{ x: 31, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 5 }, { x: 0, y: 5 }],
      },
    ],
  };

  // 折线拐点 → 逐格路径（相邻步进；斜段按先 x 后 y 展开）
  function expandPolyline(points) {
    const path = [];
    for (let i = 0; i < (points || []).length; i += 1) {
      const p = points[i];
      if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return [];
      if (i === 0) { path.push({ x: p.x, y: p.y }); continue; }
      const q = points[i - 1];
      let x = q.x, y = q.y;
      while (x !== p.x) { x += Math.sign(p.x - x); path.push({ x, y }); }
      while (y !== p.y) { y += Math.sign(p.y - y); path.push({ x, y }); }
    }
    return path;
  }

  function rotate180(points, w, h) {
    return (points || []).map((p) => ({ x: w - 1 - p.x, y: h - 1 - p.y }));
  }

  // 线路挂到地图对象：逐格展开 + 两个方向都做可走校验（含非法格的线路整条弃用并告警）
  function attachLines(map, cfgMap) {
    const defs = (cfgMap && Array.isArray(cfgMap.lines) && cfgMap.lines.length && cfgMap.lines)
      || (hasOwn(LINE_DEFS, map.id) && LINE_DEFS[map.id]) || [];
    map.lines = [];
    for (const def of defs) {
      const blue = expandPolyline(def.points);
      const red = expandPolyline(def.pointsRed || rotate180(def.points, map.width, map.height));
      const bad = [...blue, ...red].filter((t) => !map.routable(t.x, t.y));
      if (!blue.length || !red.length || bad.length) {
        if (typeof console !== "undefined") console.warn(`线路 ${map.id}/${def.id} 含不可走格，已弃用`, bad.slice(0, 4));
        continue;
      }
      map.lines.push({
        id: def.id,
        name: def.name || def.id,
        gate: def.gate || null,
        blue,
        red,
      });
    }
    return map.lines;
  }

  // 线路寻路：只把部署点/途经点与所选走廊用合法地形连接，其余严格沿走廊推进
  function bfsPath(map, from, to) {
    const key = (x, y) => `${x},${y}`;
    const prev = new Map();
    const q = [{ x: from.x, y: from.y }];
    prev.set(key(from.x, from.y), null);
    for (let i = 0; i < q.length; i += 1) {
      const cur = q[i];
      if (cur.x === to.x && cur.y === to.y) {
        const path = [];
        let k = key(cur.x, cur.y);
        while (k) {
          const parts = k.split(",");
          path.push({ x: Number(parts[0]), y: Number(parts[1]) });
          k = prev.get(k);
        }
        return path.reverse();
      }
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cur.x + d[0], ny = cur.y + d[1];
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        if (!map.routable(nx, ny)) continue;
        const kk = key(nx, ny);
        if (prev.has(kk)) continue;
        prev.set(kk, key(cur.x, cur.y));
        q.push({ x: nx, y: ny });
      }
    }
    return null;
  }

  function linePath(map, lineId, team) {
    const line = (map.lines || []).find((l) => l.id === lineId);
    if (!line) return null;
    return team === "blue" ? line.blue : line.red;
  }

  // 部署点/落点 → 所在线路（最近走廊格所属线路）；预览与服务器同一判定
  function nearestLine(map, team, tile) {
    let best = null, bd = Infinity;
    for (const line of map.lines || []) {
      const path = team === "blue" ? line.blue : line.red;
      for (const t of path) {
        const d = Math.abs(t.x - tile.x) + Math.abs(t.y - tile.y);
        if (d < bd) { bd = d; best = line; }
      }
    }
    return best;
  }

  // 敌方门格集合（该方进攻要抵达的对方门）——自定义线路终点合法性判据（预览与裁决同源）
  function enemyGates(map, team) {
    const foe = team === "blue" ? "red" : "blue";
    return ((map && map.gates && map.gates[foe]) || []).filter((g) => g && Number.isInteger(g.x) && Number.isInteger(g.y));
  }
  function isEnemyGate(map, team, tile) {
    if (!tile) return false;
    return enemyGates(map, team).some((g) => g.x === tile.x && g.y === tile.y);
  }

  // 沿线路组路：start/途经点用 BFS 接到走廊（合法地形），随后严格沿走廊走向敌目标门。
  // 自定义终点优先：高级模式逐格画到**敌方门**时，路线就在该门结束——不再接回所选线路的默认走廊/默认门。
  function buildLineRoute(map, lineId, team, start, waypoints) {
    const path = linePath(map, lineId, team);
    if (!path || !path.length) return { ok: false, reason: "未知线路" };
    const pts = [{ x: start.x, y: start.y }].concat(Array.isArray(waypoints) ? waypoints : []);
    for (const p of pts) {
      if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return { ok: false, reason: "路线含非法坐标" };
      if (p.x < 0 || p.x >= map.width || p.y < 0 || p.y >= map.height) return { ok: false, reason: "路线越界" };
      if (!map.routable(p.x, p.y)) return { ok: false, reason: "路线经过非法地块" };
    }
    let route = [];
    let cursor = pts[0];
    for (let i = 1; i < pts.length; i += 1) {
      const seg = bfsPath(map, cursor, pts[i]);
      if (!seg) return { ok: false, reason: "途经点不可达" };
      route = route.concat(route.length ? seg.slice(1) : seg);
      cursor = pts[i];
    }
    // 自定义终点=敌方门：玩家自己选的门就是终点，原样结束（不接回默认线路、不原路返回）
    if (pts.length > 1 && isEnemyGate(map, team, cursor)) {
      if (route.length > 256) return { ok: false, reason: "路线过长" };
      return { ok: true, route, lineId, gate: { x: cursor.x, y: cursor.y }, reachedGate: true };
    }
    let bi = 0, bd = Infinity;
    for (let i = 0; i < path.length; i += 1) {
      const d = Math.abs(path[i].x - cursor.x) + Math.abs(path[i].y - cursor.y);
      if (d < bd) { bd = d; bi = i; }
    }
    const join = bfsPath(map, cursor, path[bi]);
    if (!join) return { ok: false, reason: "无法接入所选线路" };
    route = route.concat(route.length ? join.slice(1) : join);
    route = route.concat(path.slice(bi + 1));
    if (route.length > 256) return { ok: false, reason: "路线过长" };
    const tail = route[route.length - 1];
    return { ok: true, route, lineId, gate: tail ? { x: tail.x, y: tail.y } : null, reachedGate: false };
  }

  function buildMaps() {
    const cross = [];
    for (let y = 0; y < 12; y += 1) {
      let row = "";
      for (let x = 0; x < 16; x += 1) {
        const high = y >= 2 && y <= 9 && x >= 4 && x <= 11;
        row += high ? (y === 5 || y === 6 ? "2" : "1") : (y === 5 || y === 6 ? "4" : "0");
      }
      cross.push(row);
    }
    const lanes = [];
    for (let y = 0; y < 12; y += 1) {
      let row = "";
      for (let x = 0; x < 16; x += 1) {
        if (y === 3 || y === 8) row += "4";                       // 两条地面通路
        else if (y >= 4 && y <= 7 && x >= 3 && x <= 12) row += (x === 6 || x === 9 ? "2" : "1"); // 中央高台与纵向通路
        else if ((y === 1 || y === 10) && (x === 2 || x === 13)) row += "3"; // 障碍
        else row += "0";
      }
      lanes.push(row);
    }
    const out = {
      cross: makeMap("cross", "十字高台", cross),
      lanes: makeMap("lanes", "双线走廊", lanes, {
        blue: [{ x: 0, y: 3 }, { x: 0, y: 8 }],
        red: [{ x: 15, y: 3 }, { x: 15, y: 8 }],
      }, 7),
    };
    // 地图包配置（public/maps.js 由 生成脚本 生成）：6 图尺寸/门/部署半场/初始部署区全出自配置
    const cfg = (typeof globalThis !== "undefined" && globalThis.AKF_MAPS) || null;
    if (cfg && Array.isArray(cfg.maps)) {
      for (const m of cfg.maps) {
        out[m.id] = makeMap(m.id, m.name, m.grid, m.gates, m.half, m.zones);
      }
    }
    // 每张地图挂完整进攻线路（配置 lines 字段优先，缺省用内置走廊折线表）
    for (const id of Object.keys(out)) {
      const cfgMap = cfg && Array.isArray(cfg.maps) ? cfg.maps.find((m) => m.id === id) : null;
      attachLines(out[id], cfgMap);
    }
    return out;
  }

  const MAPS = buildMaps();

  // ---------------- 四向朝向（高台部署选择）与世界范围变换（全项目唯一定义） ----------------
  // dir 映射：up=(0,-1) / down=(0,1) / left=(-1,0) / right=(1,0)；单位向量 ∈ {(1,0),(-1,0),(0,1),(0,-1)}
  // 查表用 Map（只认 up/down/left/right 四个自有键）："toString"/"constructor"/"__proto__" 等原型键一律不认
  const FACING_DIRS = new Map([
    ["up", { x: 0, y: -1 }],
    ["down", { x: 0, y: 1 }],
    ["left", { x: -1, y: 0 }],
    ["right", { x: 1, y: 0 }],
  ]);
  // dir 名 → 四向单位向量副本；非法名（含原型链键）返回 null
  function facingVectorOf(name) {
    if (typeof name !== "string" || !FACING_DIRS.has(name)) return null;
    const v = FACING_DIRS.get(name);
    return { x: v.x, y: v.y };
  }
  const FACING_VECTORS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  // 阵营进攻默认方向：蓝=右 / 红=左（停驻且无路线时使用）
  function factionFacing(team) {
    return team === "blue" ? { x: 1, y: 0 } : { x: -1, y: 0 };
  }
  // 归一化四向单位向量（仅接受 上/下/左/右 自有键向量；其余返回 null）
  function normalizeFacing(v) {
    if (!v || typeof v !== "object") return null;
    if (!hasOwn(v, "x") || !hasOwn(v, "y")) return null;   // 只认自有键（原型链上的 x/y 不算）
    const x = Number(v.x), y = Number(v.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const f of FACING_VECTORS) {
      if (f.x === x && f.y === y) return { x: f.x, y: f.y };
    }
    return null;
  }
  // 行进方向 → 四向（取主轴；零向量返回 null=保持原朝向）
  function facingFromDelta(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
    if (Math.abs(dx) >= Math.abs(dy)) return { x: dx > 0 ? 1 : -1, y: 0 };
    return { x: 0, y: dy > 0 ? 1 : -1 };
  }
  // 四向世界范围变换（全项目唯一定义）：官方 range_table (row=横向, col=朝向/前方) → 世界格
  // gx = unit.x + col*dx − row*dy；gy = unit.y + col*dy + row*dx（dx,dy = unit.facing）
  // 普攻/技能/治疗/阻挡反击目标等一切范围计算共用本变换（预览与服务器同一判定）。
  function gridToWorld(unit, cell) {
    const f = normalizeFacing(unit && unit.facing) || factionFacing(unit && unit.team);
    const col = cell.col, row = cell.row;
    return {
      x: unit.x + col * f.x - row * f.y,
      y: unit.y + col * f.y + row * f.x,
    };
  }

  function createSim(data) {
    const BAL = data.balance;
    const ops = new Map(data.operators.map((o) => [o.id, o]));
    const operator = (id) => ops.get(id);

    function createBattle(picks, mapId) {
      const norm = (list) => (list || []).map((e) => (e && typeof e === "object" ? e.opId : e));
      const choice = {};
      for (const list of [picks.blue, picks.red]) {
        for (const e of list || []) {
          if (e && typeof e === "object") choice[e.opId] = Number.isInteger(e.skill) ? e.skill : 0;
        }
      }
      // 地图按名查表只认自有键（"toString"/"constructor"/"__proto__" 等一律回退默认图）
      const map = (typeof mapId === "string" && hasOwn(MAPS, mapId) && MAPS[mapId]) || MAPS.cross;
      const battle = {
        started: true,
        elapsed: 0,
        seq: 0,
        mapId: map.id,
        map,
        cost: { blue: BAL.costStart, red: BAL.costStart },
        gateHp: { blue: BAL.gateHp, red: BAL.gateHp },
        units: [],
        summons: [],  // 召唤物数组（无人机/火龙/地雷等）
        hand: { blue: [], red: [] },
        picks: { blue: norm(picks.blue), red: norm(picks.red) },
        skillChoice: choice,
        events: [],
        winner: null,
      };
      for (const team of ["blue", "red"]) {
        battle.hand[team] = battle.picks[team].map((opId) => ({ opId, readyAt: 0 }));
      }
      return battle;
    }

    function log(battle, text, tone) {
      battle.events.unshift({ text, tone: tone || "", t: Math.round(battle.elapsed * 10) / 10 });
      if (battle.events.length > 80) battle.events.pop();
    }

    function skillOf(unit) {
      const op = operator(unit.opId);
      const list = op.skills && op.skills.length ? op.skills : null;
      if (list && list[unit.skillIndex]) return list[unit.skillIndex];
      return op.skill;
    }

    // SP 回复口径（skill_table levels[].spData.spType 源字段，AUTO 技同口径）：
    // INCREASE_WITH_TIME=随时间 / INCREASE_WHEN_ATTACK=攻击命中 / INCREASE_WHEN_TAKEN_DAMAGE=受伤事件
    function spModeOf(skill) {
      const t = String(skill.spType || "");
      if (t.includes("TAKEN_DAMAGE")) return "hit";     // 受击回复：仅受伤事件充能（不随时间涨）
      if (t.includes("ATTACK")) return "attack";        // 攻击回复：仅普攻命中充能（自动技也按此口径）
      return "auto";                                    // INCREASE_WITH_TIME / 未知按自动回复
    }

    function spawn(battle, opId, team, route, skillIndex, lineId) {
      const op = operator(opId);
      const start = route[0] || { x: team === "blue" ? 2 : 13, y: 5 };
      const idx = Number.isInteger(skillIndex) ? skillIndex : (battle.skillChoice && battle.skillChoice[opId]) || 0;
      const skill = (op.skills && op.skills[idx]) || op.skill;
      // 原职业部署位（op.high=远程位）与实际站位分离：部署格决定 positionMode
      const positionMode = battle.map.highDeploy(start.x, start.y) ? "high" : "ground";
      // 朝向（四向）：高台部署=待确认（facingConfirmed=false，确认前攻击/治疗/技能零输出）；
      // 地面部署=路线当前段方向（无路线=阵营进攻默认方向），自动生效无需确认
      const segFace = route.length > 1
        ? facingFromDelta(route[1].x - route[0].x, route[1].y - route[0].y) : null;
      const unit = {
        id: `u${++battle.seq}`,
        opId,
        team,
        skillIndex: idx,
        x: start.x,
        y: start.y,
        facing: positionMode === "high" ? factionFacing(team) : (segFace || factionFacing(team)),
        facingConfirmed: positionMode !== "high",   // 高台=待确认（deploy.facing 带朝向时由 applyIntent 直接确认）
        hp: op.hp,
        maxHp: op.hp,
        route: route.slice(),
        routeIndex: op.high && positionMode === "high" ? 0 : 1,
        lineId: lineId || null,                   // 本次行进的进攻线路（简化选路）
        routeLocked: route.length > 1,            // 单格部署先驻守；已有完整路线的旧部署保持锁定
        followOf: null,                           // 跟随目标单位 id（跟随系统；快照下发）
        trail: [],                                // 位置尾迹（跟随者贴路线尾随领队用）
        skillActive: false,
        skillTime: 0,
        sp: skill.initialSp || 0,               // 当前技力（原作初始 SP）
        spCost: skill.spCost || 15,             // 原作技力消耗
        spMode: spModeOf(skill),                // auto 自动回复 / attack 攻击回复 / hit 受击回复
        evadeChance: skill.evadeChance || 0,    // 概率闪避（确定性序列判闪）
        regenPct: skill.regenPct || 0,          // 每秒自愈（最大生命百分比）
        atkTimer: 0,
        blockedBy: null,
        slowUntil: 0,
        atkBuffUntil: 0,
        atkBuffMult: 1,
        defBuffUntil: 0,
        defBuffMult: 1,
        blockBuff: 0,
        highMoveCooldown: 0,
        // 高台/地面双模式：部署能力(op.high) 与实际站位/行动状态分离
        positionMode,                            // "high" 台上 | "ground" 地面（含已下地）
        descended: false,                        // 本次在场是否已选择下地行动
        highMoveLocked: positionMode === "ground", // 地面部署/已下地：本次在场禁止高台搬运
        stopReason: "idle",                      // moving | engaged | healing | casting | blocked | idle
        refundable: true,                        // 手动部署→手动撤退可返费（原作可返费规则）
        deployCostSpent: 0,                      // 部署时实际消耗（含再部署惩罚倍率）
        // 支援技状态必须显式初始化（否则首次施放 costGenLeft += totalCost 得到 NaN）
        attackDisabled: false,
        costGenLeft: 0,
        costGenRate: 0,
        healPerTick: 0,
        multishot: null,
        trueDamageUntil: 0,
        hpBonusFactor: 1,
        selfRemoveAtEnd: false,
        // —— 语义裁定落点状态（技能裁定规范）：攻击附效/受击回复/领域/免伤阶段/持续伤害 ——
        attackProc: null,
        nextAtkHeal: null,
        onDamagedHeal: null,
        dots: [],
        field: null,
        sleepUntil: 0,
        invulnerable: false,
        procAspd: 0,
      };
      battle.units.push(unit);
      
      // 召唤物系统：检查是否有部署时触发的召唤物
      if (typeof window !== 'undefined' && window.SUMMON_CONFIGS) {
        const summonCfg = window.SUMMON_CONFIGS[opId];
        if (summonCfg && summonCfg.summons) {
          for (const summon of summonCfg.summons) {
            if (summon.triggerOn === 'deploy') {
              handleSummonTrigger(battle, unit, summon, 'deploy');
            }
          }
        }
      }
      
      return unit;
    }
    
    // 召唤物触发处理
    function handleSummonTrigger(battle, summoner, summonConfig, trigger) {
      const cfg = summonConfig;
      
      if (cfg.type === 'hand') {
        // 手牌型召唤物：添加到手牌
        const count = trigger === 'deploy' ? cfg.initialCount : (cfg.onSkillAdd?.addCount || 1);
        const existing = battle.hand[summoner.team].find(c => 
          c.type === 'summon' && c.summonerId === summoner.id && c.kind === cfg.kind
        );
        
        if (existing) {
          existing.count = Math.min((existing.count || 0) + count, cfg.maxCount || 99);
        } else {
          battle.hand[summoner.team].push({
            type: 'summon',
            summonerId: summoner.id,
            summonerOpId: summoner.opId,
            kind: cfg.kind,
            count: count,
            config: cfg,
            readyAt: 0,
          });
        }
        
        const op = operator(summoner.opId);
        log(battle, `${op.name} 获得 ${count} 个${cfg.kind}`, summoner.team === 'blue' ? 'good' : 'bad');
        
      } else if (cfg.type === 'field') {
        // 场上型召唤物：直接生成
        let targetCount = 1;
        if (cfg.progressive && cfg.counts) {
          targetCount = cfg.counts[summoner.skillIndex] || 1;
        } else if (cfg.count) {
          targetCount = cfg.count;
        }
        
        // 计算当前已有同类召唤物
        const existing = battle.summons.filter(s => 
          s.summonerId === summoner.id && s.kind === cfg.kind
        );
        const needSpawn = Math.max(0, targetCount - existing.length);
        
        for (let i = 0; i < needSpawn; i++) {
          spawnFieldSummon(battle, summoner, cfg);
        }
      }
    }
    
    // 生成场上型召唤物
    function spawnFieldSummon(battle, summoner, cfg) {
      const summonId = `summon_${battle.seq++}`;
      
      // 寻找可用位置（相邻格）
      const candidates = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const x = Math.round(summoner.x) + dx;
          const y = Math.round(summoner.y) + dy;
          if (x < 0 || y < 0 || x >= battle.map.width || y >= battle.map.height) continue;
          if (!battle.map.routable(x, y)) continue;
          const occupied = battle.units.some(u => Math.round(u.x) === x && Math.round(u.y) === y) ||
                          battle.summons.some(s => Math.round(s.x) === x && Math.round(s.y) === y);
          if (!occupied) candidates.push({x, y});
        }
      }
      
      if (candidates.length === 0) {
        log(battle, `${operator(summoner.opId).name} 召唤物无可用位置`, summoner.team === 'blue' ? 'bad' : 'bad');
        return null;
      }
      
      const spawn = candidates[0];
      const stats = cfg.stats || {};
      
      const summon = {
        id: summonId,
        kind: cfg.kind,
        summonerId: summoner.id,
        summonerOpId: summoner.opId,
        team: summoner.team,
        
        hp: stats.hp !== undefined ? stats.hp : 200,
        maxHp: stats.hp !== undefined ? stats.hp : 200,
        atk: stats.atk || 0,
        def: stats.def || 0,
        res: stats.res || 0,
        aspd: stats.aspd || 100,
        range: stats.range || 1.5,
        
        x: spawn.x + 0.5,
        y: spawn.y + 0.5,
        positionMode: summoner.positionMode === 'high' ? 'high' : 'ground',
        speed: cfg.stats?.speed || 0.5,
        facing: summoner.facing,
        
        target: null,
        atkCooldown: 0,
        
        duration: stats.duration || 30,
        spawnedAt: battle.elapsed,
        
        behavior: stats.behavior || 'static',
        blockCount: stats.blockCount || 0,
        blockTerrain: stats.blockTerrain || false,
        canBeHealed: cfg.stats?.canBeHealed || false,
        
        visual: cfg.visual || {},
      };
      
      battle.summons.push(summon);
      log(battle, `${operator(summoner.opId).name} 召唤了${cfg.kind}`, summoner.team === 'blue' ? 'good' : 'bad');
      return summon;
    }

    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

    // 高台地形加成（PvP 试验基线，集中可配置；非原作数值）：
    // 在台(positionMode=high)才有；下地/地面部署立即全部失去，恢复原作地面基础值
    // 物理防护=DEF×1.15、法术防护=RES+5、输出（攻击/治疗）最终×1.10
    const HIGH_GROUND = { defMult: 1.15, resAdd: 5, outputMult: 1.10 };

    function onHigh(unit) { return unit.positionMode === "high"; }
    function outMult(battle, unit) { return onHigh(unit) ? HIGH_GROUND.outputMult : 1; }

    function effAtk(battle, unit, op) {
      return op.atk * (unit.atkBuffUntil > battle.elapsed ? unit.atkBuffMult : 1);
    }

    function effDef(battle, unit, op) {
      const base = op.def * (unit.defBuffUntil > battle.elapsed ? unit.defBuffMult : 1);
      return onHigh(unit) ? base * HIGH_GROUND.defMult : base;   // 台上物理防护
    }

    function effRes(battle, unit, op) {
      return (op.res || 0) + (onHigh(unit) ? HIGH_GROUND.resAdd : 0);   // 台上法术防护
    }

    function blockCapacity(battle, unit) {
      const op = operator(unit.opId);
      const sk = skillOf(unit);
      // 阻挡数改写（“阻挡数变为0”，如燧石·锋芒毕露）：技能期按官方描述取值
      const base = (unit.skillActive && sk && sk.blockSet != null) ? sk.blockSet : op.block;
      return base + (unit.defBuffUntil > battle.elapsed ? unit.blockBuff : 0);
    }

    // —— 统一输出门（B1：与普攻/伤害门同一层，不只挡 damage helper）——
    // facingConfirmed=false（待确认朝向）时：伤害/治疗/自愈/持续产出（回费·领域·dot）全部为 0；
    // SP 回复**不受此门**，仍按各自原规则照常（随时间/攻击命中/受伤事件）。
    function outputBlocked(unit) { return !!unit && unit.facingConfirmed === false; }

    // 完整伤害路径（PRTS《游戏数据基础》伤害公式 + 本项目最终 ×0.5 + 台上输出/防护加成）：
    // 基本伤害 A = 攻击力×攻击力倍率 + 附加攻击力（rawOverride 即技能倍率后的 A）
    // 物理 = max(0.05A, A−DEF)；法术 = max(0.05A, A×max(0,1−RES/100))；真实 = A
    // 保底 0.05A 属基础伤害层；免疫/无敌/护盾是伤判层规则，可整体取消伤害（保底不得绕过）
    // 治疗不乘伤害倍率（原值）
    function dealDamage(battle, attacker, target, type, rawOverride, opts) {
      if (attacker && attacker.facingConfirmed === false) return 0;   // 待确认朝向：一切伤害输出为 0
      if (target.invulnerable || target.evading) return 0;   // 伤判层：免疫/无敌直接取消（含保底）
      // 概率闪避（确定性序列、可复现；不触即伤判继续，保底不受影响）
      if (target.evadeChance > 0 && !(opts && opts.noEvade)) {
        battle.evadeSeq = (battle.evadeSeq || 0) + 1;
        const roll = ((battle.evadeSeq * 0.6180339887) % 1);
        if (roll < target.evadeChance) return 0;   // 闪避：本次攻击无效果
      }
      const op = operator(attacker.opId);
      const tOp = operator(target.opId);
      const A = rawOverride != null ? rawOverride : effAtk(battle, attacker, op);
      const floor = 0.05 * A;
      let raw;
      if (type === "true") {
        raw = A;
      } else if (type === "arts") {
        raw = Math.max(floor, A * Math.max(0, 1 - effRes(battle, target, tOp) / 100));
      } else {
        raw = Math.max(floor, A - effDef(battle, target, tOp));
      }
      const dmg0 = raw * BAL.dmgScale * outMult(battle, attacker);
      // 伤判层护盾吸收（技能屏障）：先扣盾再扣血（保底不绕过护盾）
      let dmg = dmg0;
      if (target.shield > 0 && battle.elapsed < (target.shieldUntil || 0)) {
        const absorbed = Math.min(target.shield, dmg);
        target.shield -= absorbed;
        dmg -= absorbed;
      }
      target.hp -= dmg;
      // 受击回复（“受到伤害时恢复X点生命”，裁定 heal 族落点）：受伤事件即刻回复
      if (dmg > 0 && target.onDamagedHeal && (target.onDamagedHeal.until || 0) > battle.elapsed) {
        healFrom(battle, target, target, target.onDamagedHeal.value);   // 自愈类产出同样受输出门
      }
      // 受击回复 SP（INCREASE_WHEN_TAKEN_DAMAGE，如岩崩锤）：每次受伤事件 +1 SP
      const tSk = skillOf(target);
      if (tSk && String(tSk.spType) === "INCREASE_WHEN_TAKEN_DAMAGE" && !target.skillActive) {
        target.sp = Math.min(target.spCost, target.sp + 1);
      }
      // 反伤（荆棘/尖刺系）：对攻击者回馈一次；反伤不再触发反伤链（noCounter）
      if (attacker && attacker !== target && !(opts && opts.noCounter)
        && target.counter && (target.counter.until || 0) > battle.elapsed) {
        const tOp = operator(target.opId);
        dealDamage(battle, target, attacker, target.counter.type || "physical",
          (tOp.atk || 0) * target.counter.power, { noCounter: true });
      }
      return dmg;
    }

    // 原作阻挡重叠（同格判定）：被阻挡单位视为停留在阻挡者格 —— 目标以其“自身格 ∪ 阻挡者格”参与受击判定
    // （PRTS《索敌的概念》：近战单位优先索敌自己阻挡的敌人、可无视攻击范围；被阻挡者亦可攻击阻挡者）
    function blockedTile(battle, unit) {
      if (unit.blockedBy) {
        const blocker = battle.units.find((u) => u.id === unit.blockedBy);
        if (blocker) return { x: blocker.x, y: blocker.y };
      }
      return null;
    }

    const FALLBACK_GRID = [{ row: 0, col: 0 }, { row: 1, col: 0 }, { row: 0, col: 1 }, { row: -1, col: 0 }, { row: 0, col: -1 }];

    // 权威命中判定（普攻与所有技能共用）：
    // - 四向世界变换 gridToWorld（row=横向，col=朝向/前方；dx,dy=单位朝向）——全项目唯一定义
    // - 待确认朝向（facingConfirmed=false）：攻击/治疗/技能一律零输出（不按默认方向先打）
    // - 近战地面不能命中高台（与普攻同一层，技能不得绕过）
    // - 阻挡同格（见 blockedTile）
    function inAttackRange(battle, unit, op, target, gridOverride, opts) {
      if (unit && unit.facingConfirmed === false) return false;
      const grid = (gridOverride && gridOverride.length) ? gridOverride
        : (op.rangeGrid && op.rangeGrid.length ? op.rangeGrid : FALLBACK_GRID);
      // 高台受击筛选只针对攻击，且按**实际站位**：台上(positionMode=high)受保护，下地/地面部署可被近战命中
      if (!(opts && opts.heal) && isMeleeOp(op) && !op.high && target.positionMode === "high") return false;
      const tx = Math.round(target.x), ty = Math.round(target.y);
      const ov = blockedTile(battle, target);
      const ox = ov ? Math.round(ov.x) : tx, oy = ov ? Math.round(ov.y) : ty;
      for (const g of grid) {
        const w = gridToWorld(unit, g);
        const gx = Math.round(w.x), gy = Math.round(w.y);
        if ((tx === gx && ty === gy) || (ox === gx && oy === gy)) return true;
      }
      return false;
    }

    function isMeleeOp(op) {
      const grid = op.rangeGrid || [];
      if (!grid.length) return true;
      return grid.every((g) => Math.abs(g.row) <= 1 && Math.abs(g.col) <= 1);
    }

    // 技能范围：官方 skill_table rangeId 格子优先（如剑雨 x-1 曼哈顿≤2、奇美拉 3-4），无则基础射程
    function skillGridOf(op, skill) {
      if (skill && skill.rangeGrid && skill.rangeGrid.length) return skill.rangeGrid;
      return op.rangeGrid && op.rangeGrid.length ? op.rangeGrid : FALLBACK_GRID;
    }

    // 技能持续期间普攻范围=技能官方范围（如至高之术/奇美拉扩大射程），同一命中判定
    function activeGridOf(unit) {
      const op = operator(unit.opId);
      const sk = skillOf(unit);
      if (unit.skillActive && sk.rangeGrid && sk.rangeGrid.length) return sk.rangeGrid;
      return skillGridOf(op, null);
    }

    // 治疗目标（原作/模式规则）：治疗范围内最低生命比例友军，范围=官方治疗格
    function lowestRatioAlly(battle, unit, skill) {
      const op = operator(unit.opId);
      const grid = skillGridOf(op, skill);
      let best = null, bestPct = 1;
      for (const ally of battle.units) {
        if (ally.team !== unit.team || ally.hp >= ally.maxHp) continue;
        if (!inAttackRange(battle, unit, op, ally, grid, { heal: true })) continue;
        const pct = ally.hp / ally.maxHp;
        if (pct < bestPct) { best = ally; bestPct = pct; }
      }
      return best;
    }

    // 特殊优先级（原作索敌第二层：阻挡 → 特殊优先级 → 仇恨/距离），按技能描述驱动：
    // 灰烬榴弹式“最靠近己方蓝门” / 神射手式“防御力最低”等
    function specialPriority(battle, unit, skill) {
      const text = ((skill && skill.desc) || "") + " " + ((skill && skill.name) || "");
      if (/最靠近/.test(text)) {
        const gates = battle.map.gates[unit.team] || [];
        if (gates.length) {
          const gateDist = (u) => Math.min(...gates.map((g) => dist(u, g)));   // 多门：取最近门
          return (a, b) => gateDist(a) - gateDist(b);
        }
      }
      if (/防御力最低/.test(text)) {
        return (a, b) => effDef(battle, a, operator(a.opId)) - effDef(battle, b, operator(b.opId));
      }
      return null;
    }

    function skillCandidates(battle, unit, skill, sideFilter) {
      const op = operator(unit.opId);
      const grid = skillGridOf(op, skill);
      const melee = isMeleeOp(op);
      const pri = sideFilter === "enemy" ? specialPriority(battle, unit, skill) : null;
      const list = battle.units
        .filter((u) => (sideFilter === "ally" ? u.team === unit.team : u.team !== unit.team))
        .filter((u) => u.id !== unit.id || sideFilter === "ally")
        .filter((u) => inAttackRange(battle, unit, op, u, grid, { heal: sideFilter === "ally" }))
        .sort((a, b) => {
          const la = melee && (a.blockedBy === unit.id || unit.blockedBy === a.id) ? 0 : 1;
          const lb = melee && (b.blockedBy === unit.id || unit.blockedBy === b.id) ? 0 : 1;
          return la - lb || (pri ? pri(a, b) : 0) || dist(unit, a) - dist(unit, b);
        });
      const maxT = skill && skill.targets ? skill.targets : (sideFilter === "ally" ? 1 : Infinity);
      return list.slice(0, Math.max(1, maxT));
    }

    function healUnit(ally, amount) {
      ally.hp = Math.min(ally.maxHp, ally.hp + amount); // 治疗原值
    }
    // 治疗输出（带来源）：来源待确认朝向 → 治疗/自愈产出为 0（与伤害门同层；SP 不受影响）
    // 同队硬门：任何路径不得治疗敌方（审查发现“奶妈给对面回血”——在治疗出口结构性封死，不依赖调用方过滤）
    function healFrom(battle, src, ally, amount) {
      if (!ally || !src || ally.team !== src.team) return 0;
      if (outputBlocked(src)) return 0;
      healUnit(ally, amount);
      return amount;
    }

    // 命中持续伤害（dotOnHit）：按来源叠加层数，每秒结算一次（updateUnit）
    function applyDot(battle, unit, target, dot) {
      if (!target.dots) target.dots = [];
      const maxStacks = Math.max(1, dot.maxStacks || 1);
      const existing = target.dots.find((d) => d.srcId === unit.id);
      if (existing) {
        existing.stacks = Math.min(maxStacks, existing.stacks + 1);
        existing.until = battle.elapsed + (dot.duration || 4);
      } else {
        target.dots.push({
          srcId: unit.id, srcOpId: unit.opId, atk: operator(unit.opId).atk,
          power: dot.power, type: "arts",
          until: battle.elapsed + (dot.duration || 4),
          stacks: 1, acc: 0,
        });
      }
    }

    // 攻击附效结算（裁定参数，技能裁定规范）：
    // 命中回费/自损/停顿/叠攻速/持续伤害/命中治疗为确定性附效；
    // 几率触发（stunChance / procChance·procList）按概率累积轮转，保证长期频率且可复现
    function applyAttackProc(battle, unit, target, proc, op) {
      proc.hits = (proc.hits || 0) + 1;
      if (proc.costOnHit > 0) {
        battle.cost[unit.team] = Math.min(BAL.costCap, battle.cost[unit.team] + proc.costOnHit);
      }
      if (proc.hpLossOnHit > 0) {
        unit.hp -= (op.atk || 0) * proc.hpLossOnHit;
      }
      if (proc.slowOnHit > 0) {
        target.slowUntil = Math.max(target.slowUntil || 0, battle.elapsed + proc.slowOnHit);
      }
      if (proc.dotOnHit) applyDot(battle, unit, target, proc.dotOnHit);
      if (proc.healOnHit > 0) {
        const ally = lowestRatioAlly(battle, unit, null);
        if (ally) healFrom(battle, unit, ally, (op.atk || 0) * proc.healOnHit * outMult(battle, unit));
      }
      if (proc.selfHealOnHit > 0) {
        healFrom(battle, unit, unit, (op.atk || 0) * proc.selfHealOnHit * outMult(battle, unit));
      }
      if (proc.aspdStack > 0) {
        unit.procAspd = Math.min(proc.aspdStackMax || 1, (unit.procAspd || 0) + proc.aspdStack);
      }
      const chance = proc.procChance > 0 ? proc.procChance : proc.stunChance;
      if (chance > 0) {
        proc.acc = (proc.acc || 0) + chance;
        if (proc.acc >= 1 - 1e-9) {
          proc.acc -= 1;
          if (proc.procChance > 0 && proc.procList && proc.procList.length) {
            const variant = proc.procList[(proc.procIndex || 0) % proc.procList.length];
            proc.procIndex = (proc.procIndex || 0) + 1;
            if (variant.stun > 0) {
              target.stunUntil = Math.max(target.stunUntil || 0, battle.elapsed + variant.stun);
            }
            if (variant.scale > 0) {
              dealDamage(battle, unit, target, proc.type || "physical", (op.atk || 0) * variant.scale, { noCounter: true });
            }
            if (variant.splash > 0) {
              for (const e2 of battle.units.filter((u) => u.team === target.team && u.id !== target.id && dist(u, target) <= 1.15)) {
                dealDamage(battle, unit, e2, proc.type || "physical", (op.atk || 0) * variant.splash, { noCounter: true });
              }
            }
          } else if (proc.stunChance > 0) {
            target.stunUntil = Math.max(target.stunUntil || 0, battle.elapsed + (proc.stun || 0.5));
          }
        }
      }
    }

    // —— 技能窗口三分（skill_table duration 真实语义，不再把 0 一律当 5 秒）——
    // 下次攻击型（duration=0 且 multishot/next_attack/next_attack_heal）：动作完成即结束，窗口=∞
    // 瞬发（duration=0 且 cost/aoe/burst/spin/true_burst/shield_ally/slow/heal）：施放即完成，本体窗口=0
    // 其余 0 持续带持续子效果（buff/def/attack_scale/attack_enchant/counter/support/field…）：子效果窗口兜底 5s
    // 持续型（duration>0）：窗口=duration
    const SKILL_ACTION_FAMILY = ["multishot", "next_attack", "next_attack_heal"];
    const SKILL_INSTANT_ONE_SHOT = ["cost", "aoe", "burst", "spin", "true_burst", "shield_ally", "slow", "heal"];

    // 技能结束收口（超时/动作完成共用）：清理 skillActive/多段/下次攻击/攻击附效/领域/免伤等技能期状态，
    // 绝不残留到技能外；结束后 SP 恢复按各自原规则照常累计。
    // 临时增益收口：动作型（窗口=∞）的临时增益在动作完成时一并清除（否则泄漏为永久增益）；
    // 其余增益按各自 until 窗口到期（与技能窗口同界/子效果兑底窗口），不提前截断。
    function finishSkill(battle, unit) {
      unit.skillActive = false;
      unit.skillTime = 0;
      unit.attackDisabled = false;
      unit.invulnerable = false;
      unit.sleepUntil = 0;
      unit.attackProc = null;
      unit.field = null;
      unit.procAspd = 0;
      unit.multishot = null;          // 多段状态收口（连射段数用完/到期即清）
      unit.nextAtk = null;            // 下次攻击型：动作完成即结束
      unit.nextAtkHeal = null;
      unit.enchant = null;
      unit.counter = null;
      if (!Number.isFinite(unit.atkBuffUntil)) { unit.atkBuffUntil = 0; unit.atkBuffMult = 1; }
      if (!Number.isFinite(unit.defBuffUntil)) { unit.defBuffUntil = 0; unit.defBuffMult = 1; unit.blockBuff = 0; }
      if (!Number.isFinite(unit.trueDamageUntil)) unit.trueDamageUntil = 0;
      if (unit.hpBonusFactor && unit.hpBonusFactor !== 1) {
        unit.maxHp = Math.round(unit.maxHp / unit.hpBonusFactor);
        unit.hp = Math.min(unit.maxHp, Math.round(unit.hp / unit.hpBonusFactor));
        unit.hpBonusFactor = 1;
      }
      if (unit.selfRemoveAtEnd) {
        // 奇美拉式结束退场：原作视为撤回干员（返费），进再部署流程
        log(battle, `${operator(unit.opId).name} 技能结束并撤退`, unit.team === "blue" ? "bad" : "good");
        exitUnit(battle, unit, "skillExit");
      }
    }

    // 下次攻击型（duration=0 且 multishot/next_attack/next_attack_heal）：一次动作 n 段后结束——
    // 动作状态（多段/强力击/转治疗充能）已打出或到期即收口，skillActive=false，SP 恢复正常累计
    function actionSkillDone(battle, unit) {
      const s = skillOf(unit);
      if (!unit.skillActive || s.duration > 0 || !SKILL_ACTION_FAMILY.includes(s.effect)) return false;
      const pending = (unit.multishot && unit.multishot.until > battle.elapsed
        && !(Number.isFinite(unit.multishot.attacksLeft) && unit.multishot.attacksLeft <= 0))
        || (unit.nextAtk && unit.nextAtk.until > battle.elapsed)
        || (unit.nextAtkHeal && unit.nextAtkHeal.until > battle.elapsed);
      return !pending;
    }

    function activateSkill(battle, unit) {
      const op = operator(unit.opId);
      const s = skillOf(unit);
      if (!op || unit.skillActive || unit.sp < unit.spCost || battle.winner) return false;
      if (unit.facingConfirmed === false) return false;   // 朝向待确认：技能一律零输出（不可施放）
      const actionSkill = !(s.duration > 0) && SKILL_ACTION_FAMILY.includes(s.effect);
      const instantSkill = !(s.duration > 0) && SKILL_INSTANT_ONE_SHOT.includes(s.effect);
      unit.skillActive = true;
      unit.skillTime = s.duration > 0 ? s.duration : (actionSkill ? Infinity : (instantSkill ? 0 : 5));
      const effWindow = s.duration > 0 ? s.duration : (actionSkill ? Infinity : 5);   // 子效果窗口（附效/增益/领域等）
      unit.sp = 0;
      // —— 通用技能参数（官方 blackboard，逐技能真实差异）——
      if (s.atkBonus) {
        unit.atkBuffUntil = battle.elapsed + effWindow;
        unit.atkBuffMult = 1 + s.atkBonus;
      }
      if (s.defBonus) {
        unit.defBuffUntil = battle.elapsed + effWindow;
        unit.defBuffMult = 1 + s.defBonus;
      }
      if (s.shield && s.effect !== "shield_ally") {
        unit.shield = (unit.shield || 0) + s.shield * op.atk;
        unit.shieldUntil = battle.elapsed + effWindow;
      }

      if (s.effect === "cost") {
        battle.cost[unit.team] = Math.min(BAL.costCap, battle.cost[unit.team] + 8);
        for (const ally of skillCandidates(battle, unit, { ...s, targets: Infinity }, "ally")) {
          healFrom(battle, unit, ally, op.atk * 1.0 * outMult(battle, unit));
        }
      }
      if ((s.effect === "aoe" || s.effect === "spin") && !(s.burstDelay > 0)) {
        // 统一权威判定：技能官方范围（如剑雨 x-1）+ 高台筛选 + 阻挡同格；目标数受 skill.targets 约束
        // 伤害类型按技能官方描述；无描述按职业（术师=法术，其余=物理，不默认转法伤）
        const typeCast = s.damageType || (op.role === "术师" ? "arts" : "physical");
        for (const enemy of skillCandidates(battle, unit, s, "enemy")) {
          dealDamage(battle, unit, enemy, typeCast, op.atk * s.power);
          if (s.stun) enemy.stunUntil = Math.max(enemy.stunUntil || 0, battle.elapsed + s.stun);
          if (s.slowAmt) enemy.slowUntil = Math.max(enemy.slowUntil || 0, battle.elapsed + effWindow);
        }
      }
      if (s.effect === "burst") {
        const targets = skillCandidates(battle, unit, s, "enemy");
        const target = targets[0];
        if (target) {
          dealDamage(battle, unit, target, s.damageType || (op.role === "术师" ? "arts" : "physical"), op.atk * s.power);
          if (s.stun) target.stunUntil = Math.max(target.stunUntil || 0, battle.elapsed + s.stun);
          if (s.slowAmt) target.slowUntil = Math.max(target.slowUntil || 0, battle.elapsed + effWindow);
        }
      }
      if (s.effect === "heal" && !(s.onDamagedHeal > 0) && !(s.selfRegen > 0)) {
        for (const ally of skillCandidates(battle, unit, { ...s, targets: Infinity }, "ally")) {
          healFrom(battle, unit, ally, op.atk * (s.power || 1.4) * outMult(battle, unit));
        }
      }
      if (s.effect === "heal" && s.onDamagedHeal > 0) {
        // 受击回复型治疗（三角初华·我思念的 / 录武官·一点关窍）：给范围内友军挂受击回复增益（含鼓舞），不做即时群疗
        for (const ally of skillCandidates(battle, unit, { ...s, targets: Infinity }, "ally")) {
          ally.onDamagedHeal = { value: s.onDamagedHeal, until: battle.elapsed + (s.onDamagedHealDur || effWindow) };
          if (s.allyInspireAtk > 0) { ally.atkBuffUntil = battle.elapsed + effWindow; ally.atkBuffMult = 1 + s.allyInspireAtk; }
          if (s.allyInspireDef > 0) { ally.defBuffUntil = battle.elapsed + effWindow; ally.defBuffMult = 1 + s.allyInspireDef; }
        }
      }
      if (s.effect === "field") {
        // 领域持续伤害（波卜·“此路不通” / 引星棘刺·解构涌潮）：每秒对范围内敌人结算，可附带友方每秒治疗
        unit.field = {
          power: s.fieldPower != null ? s.fieldPower : 0.5,
          hot: s.fieldHot != null ? s.fieldHot : 0,
          type: s.damageType || (op.role === "术师" ? "arts" : "physical"),
          acc: 0,
          until: battle.elapsed + effWindow,
        };
        if (/停止攻击|不再攻击/.test(s.desc || "")) unit.attackDisabled = true;   // 领域技停攻（伤害由领域产出）
        for (const enemy of skillCandidates(battle, unit, { ...s, targets: Infinity }, "enemy")) {
          if (s.stun) enemy.stunUntil = Math.max(enemy.stunUntil || 0, battle.elapsed + s.stun);
          if (s.slowAmt) enemy.slowUntil = Math.max(enemy.slowUntil || 0, battle.elapsed + effWindow);
        }
      }
      if (s.effect === "slow") {
        for (const enemy of skillCandidates(battle, unit, { ...s, targets: Infinity }, "enemy")) {
          enemy.slowUntil = battle.elapsed + effWindow;
        }
      }
      if (s.effect === "buff") {
        // 攻击强化：只提高攻击力（持续时间=技能窗口；duration=0 的官方瞬发技按技能窗口兑底）
        unit.atkBuffUntil = battle.elapsed + effWindow;
        unit.atkBuffMult = s.power > 0 ? s.power : 1.5;
      }
      if (s.effect === "def") {
        // 防御强化：只提高防御并增加阻挡（绝不加攻）
        unit.defBuffUntil = battle.elapsed + effWindow;
        unit.defBuffMult = s.power > 0 ? 1 + s.power : 2.5;
        unit.blockBuff = 1;
      }
      if (s.effect === "next_attack") {
        // 强力击系：仅强化接下来一次攻击（多段/连发不在内），持续至到期或打出
        unit.nextAtk = { power: s.power > 0 ? s.power : 1.8, until: battle.elapsed + effWindow };
        if (s.nextAtkHeal > 0) unit.nextAtk.healAlly = s.nextAtkHeal;   // 组合技：强力击+命中治疗（瑕光·光芒涌动）
      }
      if (s.effect === "next_attack_heal") {
        // 裁定落点（塞雷娅·急救）：下次攻击转化为单体治疗——血量比例低于阈值者中最低者优先；
        // 无合格目标不消耗充能并照常普攻；触发时敌人不掉血
        unit.nextAtkHeal = {
          scale: s.healScale != null ? s.healScale : (s.power || 1.1),
          threshold: s.healThreshold != null ? s.healThreshold : 1,
          until: battle.elapsed + unit.skillTime,
        };
      }
      if (s.selfDef) {
        // 免伤+无法行动阶段（秽壤的血脉）：selfDefDur 秒内免伤且不行动；到期解除 → 输出阶段正常可受伤
        const sleepDur = s.selfDefDur > 0 ? s.selfDefDur : 10;
        unit.sleepUntil = battle.elapsed + sleepDur;
        unit.invulnerable = true;
      }
      if (s.effect === "counter") {
        // 荆棘/尖刺系：受击反伤（对攻击者回馈一次伤害；反伤自身不再触发反伤链）
        unit.counter = {
          power: s.power > 0 ? s.power : 0.5,
          type: s.damageType || "physical",
          until: battle.elapsed + unit.skillTime,
        };
      }
      if (s.effect === "attack_enchant") {
        unit.enchant = {
          power: s.power > 0 ? s.power : 0.5,
          type: s.damageType || "arts",
          until: battle.elapsed + unit.skillTime,
        };
      }
      if (s.summon) {
        // 召唤（缺项补制的最小近似）：同数据轻量造物驻守邻格，持续 duration，到期/阵亡离场不返费
        const spot = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]
          .map(([dx, dy]) => ({ x: Math.round(unit.x) + dx, y: Math.round(unit.y) + dy }))
          .find((t) => battle.map.routable(t.x, t.y) && battle.map.inHalf(unit.team, t.x)
            && !battle.units.some((u) => Math.round(u.x) === t.x && Math.round(u.y) === t.y));
        if (spot) {
          const su = spawn(battle, unit.opId, unit.team, [spot], unit.skillIndex || 0);
          if (su) {
            su.hp = su.maxHp = Math.max(1, Math.round(su.maxHp * 0.5));
            su.atk = Math.round((su.atk || 1) * 0.8);
            su.isSummon = true;
            su.refundable = false;
            su.expireAt = battle.elapsed + (s.duration || 20);
            log(battle, `${op.name} 召唤了造物（补制近似）`, unit.team === "blue" ? "good" : "bad");
          }
        }
      }
      if (s.effect === "shield_ally") {
        // 给队友套泡/护盾（自动掩护类）：目标=治疗范围内血量比例最低的友军，不给自己
        const ally = skillCandidates(battle, unit, { ...s, targets: Infinity }, "ally")
          .filter((a) => a.id !== unit.id)
          .sort((a, c) => a.hp / a.maxHp - c.hp / c.maxHp)[0]
          || (unit.facingConfirmed === false ? null : battle.units
            .filter((a) => a.team === unit.team && a.id !== unit.id)
            .sort((a, c) => a.hp / a.maxHp - c.hp / c.maxHp)[0]);
        if (ally) {
          ally.shield = (ally.shield || 0) + (s.shield || s.power || 1) * op.atk;
          ally.shieldUntil = battle.elapsed + unit.skillTime;
        }
      }
      if (s.effect === "support") {
        // 原作支援技（如支援号令）：停止攻击，持续回费，可带每秒治疗
        unit.attackDisabled = true;
        const total = Number.isFinite(s.totalCost) ? s.totalCost : 0;   // 显式有限数：重复施放/结束/撤退都不得产生 NaN
        unit.costGenLeft = (Number.isFinite(unit.costGenLeft) ? unit.costGenLeft : 0) + total;
        unit.costGenRate = total / Math.max(1, s.duration || 1);
        unit.healPerTick = (s.healPerTick || 0) * op.atk;   // 每秒治疗 = 攻击力 × 官方 heal_scale
      }
      if (s.effect === "true_burst") {
        // 奇美拉式：真实伤害、生命上限提升、结束退场（仅 selfRemove 技能退场）
        unit.trueDamageUntil = battle.elapsed + unit.skillTime;
        const factor = 1 + (s.hpBonus || 0);
        if (factor !== 1) {
          unit.maxHp = Math.round(unit.maxHp * factor);
          unit.hp = Math.min(unit.maxHp, Math.round(unit.hp * factor));
          unit.hpBonusFactor = factor;
        }
        unit.selfRemoveAtEnd = !!s.selfRemove;
      }
      if (s.effect === "multishot") {
        // 多段（连射）：段数取官方显式值（skill_table blackboard times），无显式值才默认 2；
        // duration≤0（skill_table duration=0，如二连射·自动）=下次攻击型：只作用于接下来一次攻击动作
        unit.multishot = {
          times: Number.isInteger(s.times) && s.times > 0 ? s.times : 2,
          power: s.power || 0.33,
          until: battle.elapsed + (s.duration > 0 ? s.duration : 3),
          attacksLeft: s.duration > 0 ? Infinity : 1,
        };
      }

      // —— 逐技能攻击附效（语义裁定落点，技能裁定规范）：组合技参数拆分叠加 ——
      // atkScale 攻击倍率 / stunChance 命中几率晕眩 / slowOnHit 命中停顿 / costOnHit 攻击回费 /
      // hpLossOnHit 命中自损 / aspdStack 命中叠攻速 / dotOnHit 命中持续伤害 / procChance·procList 几率触发（确定性轮转）/
      // lowHpScale 低血量增伤 / splash 溅射（主目标全额+邻接按系数）/ healOnHit·selfHealOnHit 命中治疗
      const proc = {};
      if (s.atkScale > 1) proc.atkScale = s.atkScale;
      if (s.stunChance > 0) { proc.stunChance = s.stunChance; proc.stun = s.stun || 0.5; }
      if (s.slowOnHit > 0) proc.slowOnHit = s.slowOnHit;
      if (s.costOnHit > 0) proc.costOnHit = s.costOnHit;
      if (s.hpLossOnHit > 0) proc.hpLossOnHit = s.hpLossOnHit;
      if (s.aspdStack > 0) { proc.aspdStack = s.aspdStack; proc.aspdStackMax = s.aspdStackMax || 1; }
      if (s.dotOnHit && s.dotOnHit.power > 0) proc.dotOnHit = s.dotOnHit;
      if (s.procChance > 0 && Array.isArray(s.procList) && s.procList.length) {
        proc.procChance = s.procChance;
        proc.procList = s.procList;
      }
      if (s.lowHpScale > 0) { proc.lowHpScale = s.lowHpScale; proc.lowHpThreshold = s.lowHpThreshold || 0.5; }
      if (s.splash > 0) proc.splash = s.splash;
      if (s.healOnHit > 0) proc.healOnHit = s.healOnHit;
      if (s.selfHealOnHit > 0) proc.selfHealOnHit = s.selfHealOnHit;
      if (Object.keys(proc).length) {
        proc.until = battle.elapsed + unit.skillTime;
        proc.type = s.damageType || "physical";
        proc.acc = 0;
        proc.hits = 0;
        unit.attackProc = proc;
      }
      // 分阶段执行（标记→延时引爆，如老鲤·驱凶辟邪）：目标在施法时选定，延时后结算（目标离场则跳过）
      if (s.burstDelay > 0) {
        battle.pendingBursts = battle.pendingBursts || [];
        battle.pendingBursts.push({
          at: battle.elapsed + s.burstDelay,
          by: unit.id,
          team: unit.team,
          targets: skillCandidates(battle, unit, s, "enemy").map((e) => e.id),
          power: s.power,
          type: s.damageType || "arts",
        });
      }

      log(battle, `${op.name} 发动【${s.name}】`, unit.team === "blue" ? "good" : "bad");
      return true;
    }

    // -------------------- 召唤物系统 --------------------
    
    // 生成召唤物（自动布置型）
    function spawnSummon(battle, summoner, kind, config) {
      const summonId = `summon_${battle.seq++}`;
      const cfg = config || {};
      const offset = cfg.spawnOffset || {x: 0, y: 1};
      const targetX = summoner.x + offset.x;
      const targetY = summoner.y + offset.y;
      
      // 找可用位置（施法者周围）
      const candidates = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const x = Math.round(summoner.x) + dx;
          const y = Math.round(summoner.y) + dy;
          if (x < 0 || y < 0 || x >= battle.map.width || y >= battle.map.height) continue;
          if (!battle.map.routable(x, y)) continue;
          const occupied = battle.units.some(u => Math.round(u.x) === x && Math.round(u.y) === y) ||
                          battle.summons.some(s => Math.round(s.x) === x && Math.round(s.y) === y);
          if (!occupied) candidates.push({x, y});
        }
      }
      
      if (candidates.length === 0) return null; // 无空位
      
      const spawn = candidates[0]; // 简单取第一个
      const stats = cfg.stats || {};
      
      const summon = {
        id: summonId,
        kind: kind,
        summonerId: summoner.id,
        summonerOpId: summoner.opId,
        team: summoner.team,
        
        hp: stats.hp !== undefined ? stats.hp : 200,
        maxHp: stats.hp !== undefined ? stats.hp : 200,
        atk: stats.atk || 50,
        def: stats.def || 0,
        res: stats.res || 0,
        aspd: stats.aspd || 100,
        range: stats.range || 1.5,
        
        x: spawn.x + 0.5,
        y: spawn.y + 0.5,
        positionMode: summoner.positionMode === "high" ? "high" : "ground",
        speed: cfg.speed || 0.5,
        facing: summoner.facing,
        
        target: null,
        atkCooldown: 0,
        
        lifespan: cfg.lifespan || 30,
        spawnedAt: battle.elapsed,
        
        behavior: cfg.behavior || "static",
        patrolPath: cfg.patrolPath || [],
        patrolIndex: 0,
        
        blockCount: stats.blockCount || 0,
        canBeHealed: cfg.canBeHealed || false,
        
        stopReason: "idle",
      };
      
      battle.summons.push(summon);
      return summon;
    }
    
    // 召唤物tick逻辑
    function tickSummons(battle, dt) {
      for (let i = battle.summons.length - 1; i >= 0; i--) {
        const summon = battle.summons[i];
        
        // 检查寿命
        if (battle.elapsed - summon.spawnedAt >= summon.lifespan) {
          battle.summons.splice(i, 1);
          continue;
        }
        
        // 检查召唤者是否还在场
        const summoner = battle.units.find(u => u.id === summon.summonerId);
        if (!summoner || summoner.hp <= 0) {
          battle.summons.splice(i, 1);
          continue;
        }
        
        // 移动/攻击逻辑
        if (summon.behavior === "static") {
          // 静止：原地不动
        } else if (summon.behavior === "follow") {
          // 跟随召唤者
          const d = Math.hypot(summoner.x - summon.x, summoner.y - summon.y);
          if (d > 2) {
            const move = Math.min(summon.speed * dt, d - 1.5);
            summon.x += (summoner.x - summon.x) / d * move;
            summon.y += (summoner.y - summon.y) / d * move;
          }
        } else if (summon.behavior === "patrol") {
          // 巡逻（火龙等）
          if (summon.patrolPath.length > 1) {
            const target = summon.patrolPath[summon.patrolIndex];
            const d = Math.hypot(target.x - summon.x, target.y - summon.y);
            if (d < 0.3) {
              summon.patrolIndex = (summon.patrolIndex + 1) % summon.patrolPath.length;
            } else {
              const move = Math.min(summon.speed * dt, d);
              summon.x += (target.x - summon.x) / d * move;
              summon.y += (target.y - summon.y) / d * move;
            }
          }
        }
        
        // 攻击逻辑
        if (summon.atkCooldown > 0) {
          summon.atkCooldown -= dt;
        } else if (summon.atk > 0 && summon.hp > 0) {
          // 找目标
          const enemies = battle.units.filter(u => 
            u.team !== summon.team && 
            u.hp > 0 && 
            Math.hypot(u.x - summon.x, u.y - summon.y) <= summon.range
          );
          if (enemies.length > 0) {
            const target = enemies[0];
            const damage = Math.max(summon.atk - target.def, summon.atk * 0.05);
            target.hp -= damage;
            summon.atkCooldown = 100 / summon.aspd;
          }
        }
      }
    }

    // 阻挡重算：地面单位按阻挡容量（含技能加成）拦截相邻敌人
    function recomputeBlocking(battle) {
      const ground = battle.units.filter((u) => u.positionMode === "ground");   // 含已下地/地面部署的原高台干员
      for (const u of battle.units) u.blockedBy = null;
      const used = new Map();
      for (const e of ground) {
        for (const b of ground) {
          if (b.team === e.team) continue;
          const cap = blockCapacity(battle, b);
          if ((used.get(b.id) || 0) >= cap) continue;
          if (dist(b, e) <= 1.15) {
            used.set(b.id, (used.get(b.id) || 0) + 1);
            e.blockedBy = b.id;
            break;
          }
        }
      }
    }

    // ---------------- 跟随系统：贴路线尾随领队（各自移速、后方间距、合法步进） ----------------
    const FOLLOW_GAP = 1.15;        // 队尾与领队的后方间距（格，≥1；屏幕 ≈88px 间距口径）
    const FOLLOW_GAP_STEP = 0.95;   // 多名跟随者之间的排队间距（防重叠）
    // —— 不超前排（跟随/间距/超车规则，与跟随间距同源）——
    // 同线路行进时，低阻挡/远程/医疗（非前排）不得越过己方前排（block≥2 或 职业重装/近卫/先锋）：
    // 正前方 ≤FOLLOW_GAP（≈88px）有同向己方前排时减速/停步保持间距，到线后停在其身后交战，绝不超车。
    const FRONTLINE_ROLES = new Set(["重装", "近卫", "先锋"]);
    function isFrontline(battle, unit) {
      const uop = operator(unit.opId);
      return blockCapacity(battle, unit) >= 2 || FRONTLINE_ROLES.has(uop && uop.role);
    }
    // 超车闸：把本步候选落点夹回“前排身后 ≥FOLLOW_GAP、且沿行进方向不越过前排”之内
    function holdBehindFrontline(battle, unit, nx, ny) {
      if (isFrontline(battle, unit)) return { x: nx, y: ny };
      const dx = nx - unit.x, dy = ny - unit.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return { x: nx, y: ny };
      const ux = dx / len, uy = dy / len;
      let move = len;
      for (const ally of battle.units) {
        if (ally.id === unit.id || ally.team !== unit.team || ally.hp <= 0) continue;
        if (!isFrontline(battle, ally)) continue;
        if (!unit.lineId || ally.lineId !== unit.lineId) continue;             // 同线路=同一进攻走廊
        const rx = ally.x - unit.x, ry = ally.y - unit.y;
        const proj = rx * ux + ry * uy;                                       // 前方（沿行进方向投影）
        if (proj <= 0 || proj > 3.5 || Math.abs(rx * uy - ry * ux) > 1.6) continue;   // 只拦正前方同走廊前排
        move = Math.min(move, Math.max(0, Math.hypot(rx, ry) - FOLLOW_GAP), Math.max(0, proj - 0.35));
      }
      if (move >= len - 1e-9) return { x: nx, y: ny };
      return { x: unit.x + ux * move, y: unit.y + uy * move };
    }
    function followerRank(battle, unit, leader) {
      return battle.units.filter((u) => u.followOf === leader.id && u.id < unit.id).length;
    }
    // 跟随目标点 = 领队位置尾迹向后 gap 处（沿行进方向排队，不瞬移/不超车）
    function followTargetPoint(battle, unit, leader) {
      const gap = FOLLOW_GAP + FOLLOW_GAP_STEP * followerRank(battle, unit, leader);
      const tr = leader.trail || [];
      let acc = 0;
      let ax = leader.x, ay = leader.y;
      for (let i = 0; i < tr.length; i += 1) {
        const bx = tr[i].x, by = tr[i].y;
        const seg = Math.hypot(bx - ax, by - ay);
        if (acc + seg >= gap) {
          const r = seg > 1e-6 ? (gap - acc) / seg : 0;
          return { x: ax + (bx - ax) * r, y: ay + (by - ay) * r };
        }
        acc += seg;
        ax = bx; ay = by;
      }
      // 尾迹不足：沿尾迹方向向后外推到目标间距（仍受移速上限约束）
      let dx = ax - leader.x, dy = ay - leader.y;
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-6) { dx = unit.team === "blue" ? -1 : 1; dy = 0; }
      else { dx /= dl; dy /= dl; }
      return { x: ax + dx * (gap - acc), y: ay + dy * (gap - acc) };
    }
    function followStepLegal(battle, unit, x, y) {
      const tx = Math.round(x), ty = Math.round(y);
      if (tx < 0 || ty < 0 || tx >= battle.map.width || ty >= battle.map.height) return false;
      if (!battle.map.routable(tx, ty)) return false;                    // 不穿墙/不爬回高台（只走可走格）
      return !battle.units.some((u) => u.id !== unit.id && Math.hypot(u.x - x, u.y - y) < 0.8);   // 多跟随者不重叠
    }
    // A*寻路（跟随系统绕障碍）：从当前格找到目标格的最短可走路径
    function aStarPath(battle, unit, fromX, fromY, toX, toY) {
      const sx = Math.round(fromX), sy = Math.round(fromY);
      const gx = Math.round(toX), gy = Math.round(toY);
      if (sx === gx && sy === gy) return null;
      const open = [{ x: sx, y: sy, g: 0, h: Math.abs(gx - sx) + Math.abs(gy - sy), f: 0, parent: null }];
      const closed = new Set();
      const key = (x, y) => `${x},${y}`;
      while (open.length) {
        open.sort((a, b) => a.f - b.f);
        const cur = open.shift();
        if (cur.x === gx && cur.y === gy) {
          const path = [];
          let n = cur;
          while (n) { path.unshift({ x: n.x, y: n.y }); n = n.parent; }
          return path.slice(1); // 去掉起点
        }
        closed.add(key(cur.x, cur.y));
        for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (closed.has(key(nx, ny))) continue;
          if (!followStepLegal(battle, unit, nx + 0.5, ny + 0.5)) continue;
          const g = cur.g + 1;
          const h = Math.abs(gx - nx) + Math.abs(gy - ny);
          const existing = open.find(n => n.x === nx && n.y === ny);
          if (!existing) {
            open.push({ x: nx, y: ny, g, h, f: g + h, parent: cur });
          } else if (g < existing.g) {
            existing.g = g; existing.f = g + h; existing.parent = cur;
          }
        }
        if (open.length > 200) break; // 防止死循环
      }
      return null; // 无路径
    }
    function moveFollower(battle, unit, leader, step) {
      const d0 = Math.hypot(unit.x - leader.x, unit.y - leader.y);
      if (d0 < 1.0) return;                       // 与领队保持 ≥1 格间距：贴太近不跟进
      const target = followTargetPoint(battle, unit, leader);
      const d = Math.hypot(target.x - unit.x, target.y - unit.y);
      if (d <= 0.06) return;
      const move = Math.min(step, d);             // 各自移速：步长不超过自身 speed（不瞬移/不提速）
      const nx = unit.x + (target.x - unit.x) / d * move;
      const ny = unit.y + (target.y - unit.y) / d * move;
      const cand = [[nx, ny], [nx, unit.y], [unit.x, ny]];   // 首选斜步，非法时单轴重试（不穿格）
      for (const [cx, cy] of cand) {
        if (Math.hypot(leader.x - cx, leader.y - cy) < 1.0) continue;
        if (!followStepLegal(battle, unit, cx, cy)) continue;
        unit.x = cx; unit.y = cy;
        return;
      }
      // 简单移动失败 → A*绕路避障
      const path = aStarPath(battle, unit, unit.x, unit.y, target.x, target.y);
      if (path && path.length > 0) {
        const next = path[0];
        const stepToNext = Math.hypot(next.x - unit.x, next.y - unit.y);
        const actualMove = Math.min(step, stepToNext);
        const ratio = stepToNext > 1e-6 ? actualMove / stepToNext : 0;
        const cx = unit.x + (next.x - unit.x) * ratio;
        const cy = unit.y + (next.y - unit.y) * ratio;
        if (followStepLegal(battle, unit, cx, cy)) {
          unit.x = cx; unit.y = cy;
        }
      }
    }
    // 领队离场 → 解绑：突破=跟随者沿原线路继续、各自结算；阵亡/撤退=原地交战/待命（不冲离场点、不自动换人）
    function unbindFollowers(battle, leaderId, reason) {
      for (const u of battle.units.slice()) {
        if (u.followOf !== leaderId) continue;
        u.followOf = null;
        if (reason === "breach") {
          const built = u.lineId ? buildLineRoute(battle.map, u.lineId, u.team, { x: Math.round(u.x), y: Math.round(u.y) }, null) : null;
          if (built && built.ok) { u.route = built.route; u.routeIndex = 1; }
          else { u.routeIndex = Math.max(u.routeIndex, 1); }
          log(battle, `${operator(u.opId).name} 队长突入离场：解除跟随，沿原线路继续`, u.team === "blue" ? "good" : "bad");
        } else {
          u.route = [{ x: Math.round(u.x), y: Math.round(u.y) }];
          u.routeIndex = 1;
          log(battle, `${operator(u.opId).name} 队长离场：解除跟随，原地交战/待命`, u.team === "blue" ? "good" : "bad");
        }
      }
    }

    // 退场结算（PRTS《部署费用》撤退返费/再部署惩罚；各离场类型分开，不混同）：
    // retreat（手动撤退）/ skillExit（奇美拉式强制退场，原作视为撤回干员）→ 返费 floor(min(部署费×倍率, 基础部署费))
    // 返还倍率：默认 50%（行商 0%、冲锋手 100%——按逐人分支补，当前池暂无）
    // death / breach → 不返费；三类都叠再部署惩罚（+0.5 费用倍率/层，上限 2 层）
    function refundRateOf(op) {
      if (Number.isFinite(op.refundRate)) return op.refundRate;
      return 0.5;
    }
    function slotDeployCost(op, slot) {
      return Math.floor(op.cost * (1 + 0.5 * ((slot && slot.stacks) || 0)));
    }
    function exitUnit(battle, unit, reason) {
      const op = operator(unit.opId);
      unit.invulnerable = false;                  // 离场清理免伤状态（撤退/阵亡/突破/技能退场都不残留）
      unit.sleepUntil = 0;
      // 离场原因随快照下发（客户端区分 阵亡/突破 的死亡剪辑与 撤退/技能退场 的收势淡出）
      battle.exits = battle.exits || [];
      battle.exits.push({ id: unit.id, opId: unit.opId, team: unit.team, reason });
      if (reason === "retreat" || reason === "skillExit") {
        if (unit.refundable) {
          const refund = Math.floor(Math.min(unit.deployCostSpent * refundRateOf(op), op.cost));
          battle.cost[unit.team] = Math.min(BAL.costCap, battle.cost[unit.team] + refund);
          log(battle, `${op.name} 撤退返还部署费用 +${refund}`, unit.team === "blue" ? "good" : "bad");
        }
      } else if (reason === "death") {
        log(battle, `${op.name} 已阵亡撤退`, unit.team === "blue" ? "bad" : "good");
      } else if (reason === "breach") {
        // 突破离场（进入敌方门）：返回手牌，再部署时间已在scheduleRedeploy中×0.8
        log(battle, `${op.name} 已突破敌门返回手牌`, unit.team === "blue" ? "good" : "bad");
        unbindFollowers(battle, unit.id, reason);
        removeUnit(battle, unit);
        scheduleRedeploy(battle, unit.team, unit.opId);
        return;
      }
      unbindFollowers(battle, unit.id, reason);   // 领队离场→跟随解绑（突破续线/其余原地）
      removeUnit(battle, unit);
      scheduleRedeploy(battle, unit.team, unit.opId);
    }

    function updateUnit(battle, unit, dt) {
      const op = operator(unit.opId);

      unit.highMoveCooldown = Math.max(0, unit.highMoveCooldown - dt);
      // 召唤物持续时间：到期自然离场（不返费）
      if (unit.isSummon && unit.expireAt && battle.elapsed >= unit.expireAt) {
        exitUnit(battle, unit, "skillExit");
        return;
      }
      // 每秒自愈（如壳状防御 1%/s）：按最大生命百分比；治疗原值路径，不乘 0.5 伤害倍率
      // —— 输出门（B1）：待确认朝向=自愈产出 0（与普攻/伤害门一致）
      if (unit.regenPct > 0 && unit.hp < unit.maxHp && unit.hp > 0 && !outputBlocked(unit)) {
        healUnit(unit, unit.regenPct * unit.maxHp * dt);
      }
      // 免伤+无法行动阶段（selfDef）：到期解除免伤——输出阶段正常可受伤（不残留永久免伤）
      unit.invulnerable = unit.sleepUntil > battle.elapsed;
      if (unit.skillActive) {
        unit.skillTime -= dt;
        if (unit.skillTime <= 0) {
          // 技能窗口结束收口（超时）：与动作完成收口同一路径（skillActive/临时增益/多段状态全清）
          finishSkill(battle, unit);
          if (!battle.units.includes(unit)) return;   // 结束退场（奇美拉式）后不再继续本单位结算
        }
      }
      unit.atkTimer -= dt;

      // 支援技：持续回费 + 每秒治疗（治疗原值 × 台上治疗加成）
      // —— 输出门（B1）：待确认朝向=持续产出 0（回费暂停、不消耗余量；SP 回复不受此门）
      if (Number.isFinite(unit.costGenLeft) && unit.costGenLeft > 0 && !outputBlocked(unit)) {
        const grant = Math.min(unit.costGenLeft, unit.costGenRate * dt);
        battle.cost[unit.team] = Math.min(BAL.costCap, battle.cost[unit.team] + grant);
        unit.costGenLeft -= grant;
      }
      if (unit.skillActive && unit.healPerTick > 0) {
        const best = lowestRatioAlly(battle, unit, skillOf(unit));
        if (best) healFrom(battle, unit, best, unit.healPerTick * dt * outMult(battle, unit));
      }

      // 领域持续伤害（field）：每秒对范围内敌人结算伤害，可附带友方每秒治疗（待确认朝向=产出 0，不累积）
      if (unit.skillActive && unit.field && (unit.field.until || 0) > battle.elapsed && !outputBlocked(unit)) {
        const sField = skillOf(unit);
        unit.field.acc += dt;
        while (unit.field.acc >= 1) {
          unit.field.acc -= 1;
          const gridF = activeGridOf(unit);
          for (const e of battle.units.filter((u) => u.team !== unit.team && inAttackRange(battle, unit, op, u, gridF))) {
            dealDamage(battle, unit, e, unit.field.type, op.atk * unit.field.power);
          }
          if (unit.field.hot > 0) {
            for (const ally of skillCandidates(battle, unit, { ...sField, targets: Infinity }, "ally")) {
              healFrom(battle, unit, ally, op.atk * unit.field.hot * outMult(battle, unit));
            }
          }
        }
      }
      // 自我持续恢复（“每秒恢复最大生命”，如宴·分神）：heal 族的自身产出落点（待确认朝向=0）
      if (unit.skillActive && skillOf(unit).selfRegen > 0 && !outputBlocked(unit)) {
        unit.hp = Math.min(unit.maxHp, unit.hp + unit.maxHp * skillOf(unit).selfRegen * dt);
      }
      // 命中持续伤害结算（dotOnHit：“攻击使目标在X秒内每秒受到…伤害”，可叠加）
      if (unit.dots && unit.dots.length) {
        for (const d of unit.dots) {
          if (d.until <= battle.elapsed) continue;
          // 持续产出输出门（B1）：dot 来源单位仍在场且待确认朝向 → 不结算
          const dotSrc = d.srcId ? battle.units.find((u) => u.id === d.srcId) : null;
          if (outputBlocked(dotSrc)) continue;
          d.acc += dt;
          while (d.acc >= 1) {
            d.acc -= 1;
            dealDamage(battle, { opId: d.srcOpId, team: unit.team === "blue" ? "red" : "blue" }, unit, d.type, d.atk * d.power * d.stacks, { noCounter: true });
          }
        }
        unit.dots = unit.dots.filter((d) => d.until > battle.elapsed);
      }

      // 技力三类严格分开：仅自动型随时间；攻击回复=普攻充能；受击回复=受伤事件充能（dealDamage）
      // —— UI 显示受击回复的技能，后端不得随时间自动涨
      if (unit.spMode === "auto" && !unit.skillActive) {
        unit.sp = Math.min(unit.spCost, unit.sp + dt);
      }
      if (!unit.skillActive) {
        // 自动技（skill_table skillType=AUTO；描述含“技能自动开启”仅作辅助判据）：SP 满即自动发动
        const sk = skillOf(unit);
        if (sk && (sk.skillType === "AUTO" || /自动开启/.test(sk.desc || "")) && unit.sp >= unit.spCost) {
          activateSkill(battle, unit);
        }
      }

      // —— 行动状态机（地面行动：地面干员 + 已下地/地面部署的原高台干员）——
      // 原高台干员（含医疗）所有攻击/治疗都必须停步执行；普通地面干员未被阻挡可边走边普攻。
      // 停步判定与目标可命中性分开处理；不自动后撤/风筝，威胁解除后继续剩余路线。
      const stunned = unit.stunUntil > battle.elapsed || unit.sleepUntil > battle.elapsed;   // 免伤阶段=无法行动
      const gridNow = activeGridOf(unit);
      const enemyNear = battle.units.some((u) => u.team !== unit.team && inAttackRange(battle, unit, op, u, gridNow));
      const enemyThreat = battle.units.some((u) => u.team !== unit.team && dist(unit, u) <= 2.5);
      const woundedAlly = lowestRatioAlly(battle, unit, unit.skillActive ? skillOf(unit) : null);
      const stopsToAct = op.high === true || op.role === "医疗" || op.role === "辅助";
      let stopReason = "idle";
      if (stunned) stopReason = "stunned";
      else if (unit.blockedBy) stopReason = "blocked";
      else if (unit.skillActive) stopReason = "casting";
      else if (stopsToAct && (enemyNear || (op.role === "医疗" && enemyThreat))) stopReason = "engaged";
      else if (op.role === "医疗" && woundedAlly) stopReason = "healing";
      else if (unit.followOf && battle.units.some((u) => u.id === unit.followOf)) stopReason = "following";
      else if (unit.routeIndex < unit.route.length) stopReason = "moving";
      unit.stopReason = stopReason;
      const holdForAction = stopsToAct && (stopReason === "engaged" || stopReason === "healing");

      // 移动（先移动后动作：医疗早判不跳过地面移动）；台上原单位不自动移动
      // 简化选路：只沿已确认线路/走廊行进；跟随者改为贴路线尾随领队（各自移速，不瞬移不提速）
      const leader = unit.followOf ? battle.units.find((u) => u.id === unit.followOf) : null;
      if (unit.positionMode === "ground" && !stunned && !unit.blockedBy && !unit.skillActive && !holdForAction) {
        const slow = unit.slowUntil > battle.elapsed ? 0.5 : 1;
        const step = op.speed * slow * dt;
        if (leader) {
          const mx0 = unit.x, my0 = unit.y;
          moveFollower(battle, unit, leader, step);
          // 跟随与朝向协同（跟随=同向）：跟随者实际移动时面向与领队一致；停步保留最后有效行进方向
          if (Math.hypot(unit.x - mx0, unit.y - my0) > 1e-9) {
            const lf = normalizeFacing(leader.facing);
            if (lf) unit.facing = { x: lf.x, y: lf.y };
          }
        } else if (unit.routeIndex < unit.route.length) {
          const t = unit.route[unit.routeIndex];
          const d = Math.hypot(t.x - unit.x, t.y - unit.y);
          const face = facingFromDelta(t.x - unit.x, t.y - unit.y);   // 行军中：朝向=当前行进段方向
          if (d <= step || d < 0.02) {
            // 不超前排：候选落点夹回前排身后（≥FOLLOW_GAP≈88px、沿行进方向不越线）
            const held = holdBehindFrontline(battle, unit, t.x, t.y);
            unit.x = held.x; unit.y = held.y;
            if (Math.hypot(t.x - unit.x, t.y - unit.y) < 1e-6) unit.routeIndex += 1;
          } else {
            const held = holdBehindFrontline(battle, unit, unit.x + (t.x - unit.x) / d * step, unit.y + (t.y - unit.y) / d * step);
            unit.x = held.x; unit.y = held.y;
          }
          if (face) unit.facing = face;
        }
      }
      // 位置尾迹（跟随目标点 = 领队尾迹后方间距点）
      if (!unit.trail || !unit.trail.length || Math.hypot(unit.x - unit.trail[0].x, unit.y - unit.trail[0].y) > 0.3) {
        if (!unit.trail) unit.trail = [];
        unit.trail.unshift({ x: unit.x, y: unit.y });
        if (unit.trail.length > 60) unit.trail.pop();
      }

      // 医疗：治疗最低生命比例友军（治疗原值 × 台上加成；技能期用技能官方治疗格；敌人不是治疗目标）
      if (op.role === "医疗") {
        if (!stunned && unit.atkTimer <= 0) {
          const best = lowestRatioAlly(battle, unit, unit.skillActive ? skillOf(unit) : null);
          if (best) {
            const bonus = unit.skillActive ? (skillOf(unit).power || 1.5) : 1;
            healUnit(best, op.atk * bonus * outMult(battle, unit));
            // 治疗干员后为其施加受击回复增益（录武官·一点关窍）
            const skh = unit.skillActive ? skillOf(unit) : null;
            if (skh && skh.onDamagedHeal > 0) {
              best.onDamagedHeal = { value: skh.onDamagedHeal, until: battle.elapsed + (skh.onDamagedHealDur || skh.duration || unit.skillTime) };
            }
          }
          unit.atkTimer = op.aspd;
        }
      } else {
        // 目标选择：阻挡互锁（近战，原作可无视范围）→ 特殊优先级 → 距离
        const enemies = battle.units.filter((u) => u.team !== unit.team);
        const melee = isMeleeOp(op);
        const pri = unit.skillActive ? specialPriority(battle, unit, skillOf(unit)) : null;
        const candidates = enemies
          .filter((e) => inAttackRange(battle, unit, op, e, gridNow))
          .sort((a, b) => {
            const la = melee && (a.blockedBy === unit.id || unit.blockedBy === a.id) ? 0 : 1;
            const lb = melee && (b.blockedBy === unit.id || unit.blockedBy === b.id) ? 0 : 1;
            return la - lb || (pri ? pri(a, b) : 0) || dist(unit, a) - dist(unit, b);
          });

        // 普攻（支援技期间停止攻击；技能持续输出期间照常）
        if (!unit.attackDisabled && !stunned && candidates.length && unit.atkTimer <= 0) {
          const sk = skillOf(unit);
          // 裁定落点：下次攻击转化为单体治疗（塞雷娅·急救）——合格目标（血量比例<阈值）中最低者优先；
          // 无合格目标不消耗充能并照常普攻；触发时敌人不掉血
          const nHeal = unit.nextAtkHeal && unit.nextAtkHeal.until > battle.elapsed ? unit.nextAtkHeal : null;
          const healedAlly = nHeal
            ? (skillCandidates(battle, unit, { ...sk, targets: Infinity }, "ally")
              .filter((a) => a.hp < a.maxHp * (nHeal.threshold != null ? nHeal.threshold : 1))
              .sort((a, c) => a.hp / a.maxHp - c.hp / c.maxHp)[0] || null)
            : null;
          if (healedAlly) {
            healFrom(battle, unit, healedAlly, op.atk * (nHeal.scale != null ? nHeal.scale : 1.1) * outMult(battle, unit));
            unit.nextAtkHeal = null;                       // 才消耗充能（无合格目标时不消耗）
            unit.atkTimer = op.aspd;
          } else {
          const aoe = unit.skillActive && (sk.effect === "aoe" || sk.effect === "spin");
          let maxTargets = Math.max(1, op.atkTargets || 1);
          if (unit.skillActive && sk.targets) maxTargets = sk.targets;
          else if (aoe) maxTargets = candidates.length;
          const trueDmg = unit.trueDamageUntil > battle.elapsed;
          const arts = op.role === "术师" || (op.id === "lappland" && unit.skillActive);
          // 技能期伤害类型按技能官方描述（真实/法术/物理）；无描述按职业（不默认转法伤）
          const type = trueDmg ? "true"
            : (unit.skillActive && sk.damageType ? sk.damageType : (arts ? "arts" : "physical"));
          const multishot = unit.multishot && unit.multishot.until > battle.elapsed;
          const times = multishot ? unit.multishot.times : 1;
          const nextA = unit.nextAtk && unit.nextAtk.until > battle.elapsed ? unit.nextAtk : null;
          const enchant = unit.enchant && unit.enchant.until > battle.elapsed ? unit.enchant : null;
          const proc = unit.attackProc && (unit.attackProc.until || 0) > battle.elapsed ? unit.attackProc : null;
          for (let t = 0; t < times; t += 1) {
            // 单次人数上限（逐技能 targets/capTargets）：多段同样受上限约束，不默认取全部候选
            const list = candidates.slice(0, Math.max(1, maxTargets));
            for (const e of list) {
              // 强力击系：仅强化本次动作命中的第一下；附伤系（狼魂等）：每击追加一段
              let raw;
              if (multishot) raw = op.atk * unit.multishot.power;
              else if (nextA) {
                raw = op.atk * nextA.power;
                if (nextA.healAlly > 0) {
                  // 组合技拆参：强力击+命中治疗（瑕光·光芒涌动）
                  const ally = lowestRatioAlly(battle, unit, null);
                  if (ally) healFrom(battle, unit, ally, op.atk * nextA.healAlly * outMult(battle, unit));
                }
                unit.nextAtk = null;
              }
              let hit = raw;
              if (proc && proc.atkScale > 1 && hit == null) hit = effAtk(battle, unit, op) * proc.atkScale;
              if (proc && proc.lowHpScale > 0 && e.hp < e.maxHp * (proc.lowHpThreshold || 0.5)) {
                hit = (hit != null ? hit : effAtk(battle, unit, op)) * proc.lowHpScale;
              }
              dealDamage(battle, unit, e, type, hit);
              // 溅射（裁定落点）：主目标全额，邻接目标按技能系数
              if (proc && proc.splash > 0) {
                const splashBase = hit != null ? hit : effAtk(battle, unit, op);
                for (const e2 of battle.units.filter((u) => u.team === e.team && u.id !== e.id && dist(u, e) <= 1.15)) {
                  dealDamage(battle, unit, e2, type, splashBase * proc.splash, { noCounter: true });
                }
              }
              if (enchant) dealDamage(battle, unit, e, enchant.type, op.atk * enchant.power);
              if (proc) applyAttackProc(battle, unit, e, proc, op);
              if (unit.spMode === "attack" && !unit.skillActive) unit.sp = Math.min(unit.spCost, unit.sp + 1);
            }
          }
          // 下次攻击型多段（duration=0，如二连射·自动）：本次攻击动作后立即结束（“下次攻击连续射击N次”）
          if (multishot && unit.multishot && Number.isFinite(unit.multishot.attacksLeft)) {
            unit.multishot.attacksLeft -= 1;
            if (unit.multishot.attacksLeft <= 0) unit.multishot = null;
          }
          // 技能期攻速：官方 attack_speed（aspdBonus）+ 命中叠攻速（aspdStack），其次调优近似
          const spdAdd = (sk.aspdBonus != null ? sk.aspdBonus : 0) + (unit.procAspd || 0);
          const atkSpeedFactor = unit.skillActive
            ? (sk.aspdBonus != null || unit.procAspd ? 100 / (100 + spdAdd) : (sk.effect === "buff" ? 0.6 : 1))
            : 1;
          unit.atkTimer = op.aspd * atkSpeedFactor;
          }
        }
      }

      // —— B3 下次攻击型收口（duration=0：一次动作 n 段后结束，如克洛丝二连射 times=2）——
      // 动作状态（多段/强力击/转治疗充能）打出或到期 → 立即结束技能窗口：skillActive=false、
      // 多段/临时增益收口、SP 恢复按各自原规则照常累计（此前段数用完仍 skillActive，SP 卡 0）
      if (actionSkillDone(battle, unit)) {
        finishSkill(battle, unit);
        if (!battle.units.includes(unit)) return;
      }

      // 破门（地面行动含已下地原高台干员；多门共享目标生命；一次突破只扣一次，突破单位立即离场）
      // 跟随中不单独结算突破：领队离场解绑后各自沿原线路推进、各自结算
      if (unit.positionMode === "ground" && !unit.breached && !unit.followOf && unit.routeIndex >= unit.route.length) {
        const gateTeam = unit.team === "blue" ? "red" : "blue";
        const gates = battle.map.gates[gateTeam] || [];
        const atGate = gates.some((g) => Math.abs(unit.x - g.x) <= 1.1 && Math.abs(unit.y - g.y) <= 1.6);
        if (atGate) {
          unit.breached = true;   // 幂等：同一单位只结算一次突破
          const breach = Number.isFinite(op.breach) ? op.breach : 1;   // 0 权重（医疗/辅助·暂定）不扣血但同样离场
          battle.gateHp[gateTeam] = Math.max(0, battle.gateHp[gateTeam] - breach);
          log(battle, `${op.name} 突入${gateTeam === "red" ? "红方" : "蓝方"}蓝门，目标生命 -${breach}`, unit.team === "blue" ? "good" : "bad");
          exitUnit(battle, unit, "breach");
        }
      }
    }

    function removeUnit(battle, unit) {
      battle.units = battle.units.filter((u) => u.id !== unit.id);
    }

    function scheduleRedeploy(battle, team, opId, redeploySec) {
      const slot = battle.hand[team].find((h) => h.opId === opId);
      const op = operator(opId);
      // 原作再部署惩罚：每次退场（撤退/阵亡/突破/技能退场）+0.5 费用倍率/层，上限 2 层
      if (slot) {
        slot.stacks = Math.min(2, (slot.stacks || 0) + 1);
        // 所有再部署时间×0.8（降低20%，加快游戏节奏）
        const baseTime = redeploySec != null ? redeploySec : (op.redeployTime || 70);
        slot.readyAt = battle.elapsed + Math.round(baseTime * 0.8);
      }
    }

    function tick(battle, dt) {
      if (!battle.started || battle.winner) return;
      battle.exits = battle.exits || [];        // 离场事件自上次快照累计（快照消费后清空；意图型离场不被 tick 重置吞掉）
      battle.elapsed += dt;
      for (const team of ["blue", "red"]) {
        battle.cost[team] = Math.min(BAL.costCap, battle.cost[team] + BAL.costRegen * dt);
      }
      recomputeBlocking(battle);
      
      // 召唤物tick
      tickSummons(battle, dt);
      
      for (const unit of battle.units.slice()) {
        if (unit.hp <= 0) {
          exitUnit(battle, unit, "death");
          continue;
        }
        updateUnit(battle, unit, dt);
      }
      // 分阶段延时引爆（标记→爆炸，老鲤·驱凶辟邪）：到点对原目标结算（目标/施法者离场则跳过该目标）
      if (battle.pendingBursts && battle.pendingBursts.length) {
        const due = battle.pendingBursts.filter((p) => p.at <= battle.elapsed);
        battle.pendingBursts = battle.pendingBursts.filter((p) => p.at > battle.elapsed);
        for (const p of due) {
          const by = battle.units.find((u) => u.id === p.by);
          if (!by) continue;
          const atk = operator(by.opId).atk;
          for (const id of p.targets) {
            const target = battle.units.find((u) => u.id === id);
            if (target) dealDamage(battle, by, target, p.type, atk * p.power, { noCounter: true });
          }
        }
      }
      if (battle.gateHp.red <= 0 || battle.gateHp.blue <= 0) {
        battle.winner = battle.gateHp.red <= 0 && battle.gateHp.blue <= 0
          ? "draw"
          : battle.gateHp.red <= 0 ? "blue" : "red";
        log(battle, battle.winner === "draw" ? "双方目标生命同时归零 · 平局" : battle.winner === "blue" ? "蓝方获胜：红门被攻破" : "红方获胜：蓝门被攻破", "sys");
      }
    }

    // ---------------- 意图校验（服务器权威） ----------------
    function validateDeploy(battle, team, opId, routeArr, skillIndex, facingRaw) {
      const op = operator(opId);
      if (!op) return { ok: false, reason: "未知干员" };
      // —— deploy 可选 facing:{x,y}：仅接受四向单位向量；有则直接确认，无则（高台）进入待确认 ——
      let facing = null;
      if (facingRaw !== undefined && facingRaw !== null) {
        facing = normalizeFacing(facingRaw);
        if (!facing) return { ok: false, reason: "非法朝向（仅接受上/下/左/右单位向量）" };
      }
      if (!battle.picks[team].includes(opId)) return { ok: false, reason: "该干员不在你的阵容" };
      const slot = battle.hand[team].find((h) => h.opId === opId);
      if (!slot) return { ok: false, reason: "手牌没有该干员" };
      if (slot.readyAt > battle.elapsed) return { ok: false, reason: "再部署冷却中" };
      // —— 携带技能固定：部署只能用 draft 已确认的技能，改包换技/越界技能一律拒绝 ——
      const skillCount = (op.skills && op.skills.length) ? op.skills.length : 1;
      const chosen = Number.isInteger(battle.skillChoice && battle.skillChoice[opId]) ? battle.skillChoice[opId] : 0;
      if (skillIndex !== undefined && skillIndex !== null) {
        if (!Number.isInteger(skillIndex) || skillIndex < 0 || skillIndex >= skillCount) {
          return { ok: false, reason: "非法技能选择" };
        }
        if (skillIndex !== chosen) {
          return { ok: false, reason: "技能选择与已确认携带不符" };
        }
      }
      // —— 路线语义：route=逐格数组（显式路线/兼容）或 {line,start,waypoints}（沿线路，途经点高级可选）——
      // —— 先结构/整数/边界/逐格校验，再读取任何字段 ——
      let route = null;
      let lineId = null;
      if (Array.isArray(routeArr)) {
        route = routeArr;
      } else if (routeArr && typeof routeArr === "object" && routeArr.start) {
        const st = routeArr.start;
        if (!st || typeof st !== "object" || !Number.isInteger(st.x) || !Number.isInteger(st.y)) {
          return { ok: false, reason: "路线含非法坐标" };
        }
        if (st.x < 0 || st.x >= battle.map.width || st.y < 0 || st.y >= battle.map.height) {
          return { ok: false, reason: "路线越界" };
        }
        lineId = routeArr.line || null;
        if (!battle.map.highDeploy(st.x, st.y)) {
          // 地面行动：沿线路推进（部署点/途经点只与走廊做合法连接，不做全员最短路）
          const built = buildLineRoute(battle.map, lineId, team, st, routeArr.waypoints);
          if (!built.ok) return built;
          route = built.route;
        } else {
          // 台上部署：驻守锚点（不下地不移动）；仍记录所选线路，供 F 下台后续线
          route = [{ x: st.x, y: st.y }];
          if (lineId && !linePath(battle.map, lineId, team)) return { ok: false, reason: "未知线路" };
        }
      } else {
        return { ok: false, reason: "路线非法" };
      }
      const maxLen = lineId ? 256 : 64;
      if (!Array.isArray(route) || route.length === 0 || route.length > maxLen) return { ok: false, reason: "路线非法" };
      for (const t of route) {
        if (!t || typeof t !== "object" || !Number.isInteger(t.x) || !Number.isInteger(t.y)) {
          return { ok: false, reason: "路线含非法坐标" };
        }
        if (t.x < 0 || t.x >= battle.map.width || t.y < 0 || t.y >= battle.map.height) return { ok: false, reason: "路线越界" };
      }
      const start = route[0];
      // —— 合法初始部署区贯通（B4，与 maps.json zones.initialDeploy 同源）——
      // 有配置的图：落点必须在 zones.initialDeploy[team] 矩形内（含端点）∩ 己方半场（半场外仍报半场错）；
      // 无配置的内置图（cross/lanes）：inInitialDeploy 回退整半场，行为不变。
      if (!battle.map.inHalf(team, start.x)) return { ok: false, reason: "只能在己方半场部署" };
      if (!battle.map.inInitialDeploy(team, start.x, start.y)) return { ok: false, reason: "只能在初始部署区部署" };
      // 双部署：原高台干员（远程位）可上台，也可直接落在己方合法地面格（下地部署，无台上加成）
      const okTerrain = op.high
        ? (battle.map.highDeploy(start.x, start.y) || battle.map.groundDeploy(start.x, start.y))
        : battle.map.groundDeploy(start.x, start.y);
      if (!okTerrain) {
        return { ok: false, reason: op.high ? "非法部署地块" : "地面干员不能部署在高台" };
      }
      if (battle.units.some((u) => Math.round(u.x) === start.x && Math.round(u.y) === start.y)) {
        return { ok: false, reason: "该位置已有干员" };
      }
      if (battle.units.some((u) => u.team === team && u.opId === opId)) {
        return { ok: false, reason: "该干员已在场上" };   // 原作：同名干员同屏唯一
      }
      for (let i = 1; i < route.length; i += 1) {
        const a = route[i - 1], b = route[i];
        const adj = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
        if (!adj) return { ok: false, reason: "路线不连续" };
        if (!battle.map.routable(b.x, b.y)) return { ok: false, reason: "路线经过非法地块" };
      }
      if (battle.cost[team] < slotDeployCost(op, slot)) return { ok: false, reason: "部署费用不足" };
      return { ok: true, op, slot, route, lineId, facing };
    }

    function applyIntent(battle, team, intent) {
      if (battle.winner) return { ok: false, reason: "对局已结束" };
      if (intent.kind === "deploy") {
        const v = validateDeploy(battle, team, intent.opId, intent.route, intent.skillIndex, intent.facing);
        if (!v.ok) return v;
        const paid = slotDeployCost(v.op, v.slot);          // 含再部署惩罚倍率的本次部署费用
        battle.cost[team] = Math.max(0, battle.cost[team] - paid);
        const unit = spawn(battle, intent.opId, team, v.route, intent.skillIndex, v.lineId);
        unit.deployCostSpent = paid;
        if (v.facing) {
          // deploy.facing 有值=直接确认（否则高台单位进入待确认，由 facing 意图确认）
          unit.facing = { x: v.facing.x, y: v.facing.y };
          unit.facingConfirmed = true;
        }
        log(battle, `${v.op.name} 已部署（${unit.id}${v.lineId ? "·沿线路" : ""}）`, team === "blue" ? "good" : "bad");
        return { ok: true, unitId: unit.id };
      }
      if (intent.kind === "march") {
        // 已部署单位确认一次完整线路：由服务器当前位置组路，不重复部署/扣费。
        const unit = battle.units.find((u) => u.id === intent.unitId);
        if (!unit || unit.team !== team) return { ok: false, reason: "不能操作对方单位" };
        if (unit.hp <= 0) return { ok: false, reason: "单位已离场" };
        if (unit.positionMode !== "ground") return { ok: false, reason: "高台驻守不可行军，请先下地" };
        if (unit.followOf) return { ok: false, reason: "跟随中不能确认行军线路" };
        if (unit.routeLocked || unit.route.length > 1) return { ok: false, reason: "行军线路已锁定" };
        if (!Number.isFinite(unit.x) || !Number.isFinite(unit.y)) return { ok: false, reason: "非法行军起点" };
        const start = { x: Math.round(unit.x), y: Math.round(unit.y) };
        if (start.x < 0 || start.x >= battle.map.width || start.y < 0 || start.y >= battle.map.height
          || !battle.map.routable(start.x, start.y)) return { ok: false, reason: "非法行军起点" };
        if (typeof intent.line !== "string" || !intent.line || !linePath(battle.map, intent.line, team)) {
          return { ok: false, reason: "未知线路" };
        }
        if (intent.waypoints != null && (!Array.isArray(intent.waypoints) || intent.waypoints.length > 64)) {
          return { ok: false, reason: "途经点非法" };
        }
        const built = buildLineRoute(battle.map, intent.line, team, start, intent.waypoints);
        if (!built.ok) return built;
        unit.route = built.route;
        unit.routeIndex = 1;
        unit.lineId = built.lineId;
        unit.routeLocked = true;
        unit.stopReason = "moving";
        // 行军朝向=路线当前段方向（行军中随移动段更新；停步保留最后有效行进方向）
        if (built.route.length > 1) {
          const mf = facingFromDelta(built.route[1].x - built.route[0].x, built.route[1].y - built.route[0].y);
          if (mf) unit.facing = mf;
        }
        log(battle, `${operator(unit.opId).name} 确认行军线路`, team === "blue" ? "good" : "bad");
        return { ok: true, unitId: unit.id };
      }
      if (intent.kind === "descend") {
        // 下地行动：原高台干员从合法相邻地面/下台点进入已确认路线；失去台上加成，本次在场禁用高台搬运
        const unit = battle.units.find((u) => u.id === intent.unitId);
        if (!unit || unit.team !== team) return { ok: false, reason: "不能操作对方单位" };
        const op = operator(unit.opId);
        if (!op.high) return { ok: false, reason: "不是可下地的远程位干员" };
        if (unit.positionMode !== "high") return { ok: false, reason: "已在地面行动" };
        if (!Number.isInteger(intent.x) || !Number.isInteger(intent.y)) return { ok: false, reason: "非法下台点" };
        if (intent.x < 0 || intent.x >= battle.map.width || intent.y < 0 || intent.y >= battle.map.height) return { ok: false, reason: "非法下台点" };
        // F 下地落点权限（与 R 搬运各自判定）：在场**移动**权限——四邻地面可走格 ∧ 己方半场 ∧ 无占位；
        // 不重复查 zones.initialDeploy（初始部署区只约束"部署/上台落点"，在场移动/行军不受其限）
        if (!battle.map.inHalf(team, intent.x)) return { ok: false, reason: "下台点必须在己方半场" };
        if (!battle.map.groundDeploy(intent.x, intent.y) || !battle.map.routable(intent.x, intent.y)) {
          return { ok: false, reason: "非法下台点" };
        }
        const adj = Math.abs(Math.round(unit.x) - intent.x) + Math.abs(Math.round(unit.y) - intent.y) === 1;
        if (!adj) return { ok: false, reason: "下台点必须与当前位置相邻" };
        if (battle.units.some((u) => u.id !== unit.id && Math.round(u.x) === intent.x && Math.round(u.y) === intent.y)) {
          return { ok: false, reason: "该位置已有干员" };
        }
        let route = [{ x: intent.x, y: intent.y }];
        let lineId = unit.lineId || null;
        if (Array.isArray(intent.route) && intent.route.length > 1) {
          if (intent.route.length > 64) return { ok: false, reason: "路线非法" };
          for (let i = 0; i < intent.route.length; i += 1) {
            const t = intent.route[i];
            if (!t || !Number.isInteger(t.x) || !Number.isInteger(t.y)) return { ok: false, reason: "路线含非法坐标" };
            if (t.x < 0 || t.x >= battle.map.width || t.y < 0 || t.y >= battle.map.height) return { ok: false, reason: "路线越界" };
            if (i === 0 && (t.x !== intent.x || t.y !== intent.y)) return { ok: false, reason: "路线起点必须是下台点" };
            if (i > 0) {
              const a = intent.route[i - 1];
              if (Math.abs(a.x - t.x) + Math.abs(a.y - t.y) !== 1) return { ok: false, reason: "路线不连续" };
              if (!battle.map.routable(t.x, t.y)) return { ok: false, reason: "路线经过非法地块" };
            }
          }
          route = intent.route.slice();
        } else {
          // 线路续行：F 下台不只发落点 —— 沿所选/原线路继续推进（无线路则驻守落点）
          const wantLine = intent.line || unit.lineId;
          if (wantLine) {
            const built = buildLineRoute(battle.map, wantLine, team, { x: intent.x, y: intent.y }, intent.waypoints);
            if (built.ok) { route = built.route; lineId = built.lineId; }
            else if (intent.line) return { ok: false, reason: built.reason };
          }
        }
        unit.x = intent.x; unit.y = intent.y;
        unit.positionMode = "ground";
        unit.descended = true;
        unit.highMoveLocked = true;                 // 本次在场禁止再上台/R 搬运
        unit.route = route;
        unit.lineId = lineId;
        unit.routeLocked = !!unit.routeLocked || route.length > 1;
        unit.routeIndex = 1;
        unit.stopReason = "moving";
        // F 下地/地面朝向规则：默认=路线当前段方向；停驻无路线=阵营进攻默认方向（自动管理，无需再确认）
        unit.facing = (route.length > 1
          ? facingFromDelta(route[1].x - route[0].x, route[1].y - route[0].y) : null) || factionFacing(team);
        unit.facingConfirmed = true;
        log(battle, `${op.name} 下地行动（${intent.x},${intent.y}），失去台上加成`, team === "blue" ? "good" : "bad");
        return { ok: true };
      }
      if (intent.kind === "follow") {
        // 跟随意图（服务器权威）：同队、目标存在、非自己、无循环链；targetId=null=解除跟随
        const unit = battle.units.find((u) => u.id === intent.unitId);
        if (!unit || unit.team !== team) return { ok: false, reason: "不能操作对方单位" };
        const uName = operator(unit.opId).name;
        if (intent.targetId === null || intent.targetId === undefined) {
          if (!unit.followOf) return { ok: false, reason: "该单位未建立跟随" };
          unit.followOf = null;
          unit.route = [{ x: Math.round(unit.x), y: Math.round(unit.y) }];
          unit.routeIndex = 1;
          log(battle, `${uName} 解除跟随，原地交战/待命`, team === "blue" ? "good" : "bad");
          return { ok: true };
        }
        if (typeof intent.targetId !== "string") return { ok: false, reason: "非法跟随目标" };
        const target = battle.units.find((u) => u.id === intent.targetId);
        if (!target) return { ok: false, reason: "跟随目标不存在" };
        if (target.team !== team) return { ok: false, reason: "只能跟随己方干员" };
        if (target.id === unit.id) return { ok: false, reason: "不能跟随自己" };
        // 循环链校验：沿 followOf 上溯，任何回到自己的链路（含直接互跟）一律拒绝
        let cur = target, hops = 0;
        while (cur && cur.followOf && hops < 64) {
          if (cur.followOf === unit.id) return { ok: false, reason: "跟随关系不能成环" };
          cur = battle.units.find((u) => u.id === cur.followOf);
          hops += 1;
        }
        if (hops >= 64) return { ok: false, reason: "跟随关系不能成环" };
        unit.followOf = target.id;
        log(battle, `${uName} 跟随 ${operator(target.opId).name}`, team === "blue" ? "good" : "bad");
        return { ok: true };
      }
      if (intent.kind === "retreat") {
        // 主动撤退（任意状态可撤）：owner 校验、一次结算、解除阻挡/效果引用、按原作返费、进自身再部署
        const unit = battle.units.find((u) => u.id === intent.unitId);
        if (!unit || unit.team !== team) return { ok: false, reason: "不能操作对方单位" };
        const name = operator(unit.opId).name;
        exitUnit(battle, unit, "retreat");
        log(battle, `${name} 主动撤退`, team === "blue" ? "bad" : "good");
        return { ok: true };
      }
      if (intent.kind === "facing") {
        // 高台四向朝向确认（服务器权威）：单位存在/属于本人/仅台上/每单位仅一次；dir→向量严格映射
        const unit = battle.units.find((u) => u.id === intent.unitId);
        if (!unit) return { ok: false, reason: "单位不存在" };
        if (unit.team !== team) return { ok: false, reason: "不能操作对方单位" };
        // dir→向量只认 up/down/left/right 四个自有键（Map）："toString"/"constructor"/"__proto__" 一律非法，
        // 且非法 dir 拒绝**不动任何状态**（位置/费用/冷却/facing/facingConfirmed 逐字段不变）
        const f = facingVectorOf(intent.dir);
        if (!f) return { ok: false, reason: "非法朝向（仅 up/down/left/right）" };
        if (unit.positionMode !== "high") return { ok: false, reason: "该单位不在高台上（地面单位按行进方向自动朝向）" };
        if (unit.facingConfirmed) return { ok: false, reason: "朝向已确认，每个单位仅可确认一次" };
        unit.facing = { x: f.x, y: f.y };
        unit.facingConfirmed = true;
        log(battle, `${operator(unit.opId).name} 确认朝向（${intent.dir}）`, team === "blue" ? "good" : "bad");
        return { ok: true, unitId: unit.id };
      }
      if (intent.kind === "skill") {
        const unit = battle.units.find((u) => u.id === intent.unitId);
        if (!unit) return { ok: false, reason: "单位不存在" };
        if (unit.team !== team) return { ok: false, reason: "不能操作对方单位" };
        // —— 统一状态门禁（B1）：facingConfirmed=false = 技能意图明确拒绝（不施法/不扣 SP/不产出）——
        if (unit.facingConfirmed === false) return { ok: false, reason: "未确认朝向，无法施放技能" };
        // —— 自动技（skill_table skillType=AUTO）：SP 满即自动发动，服务器拒绝手动施放（与界面口径一致）——
        const sk0 = skillOf(unit);
        if (sk0 && sk0.skillType === "AUTO") {
          return { ok: false, reason: "自动技无需手动施放（充能满后自动发动）" };
        }
        return activateSkill(battle, unit) ? { ok: true } : { ok: false, reason: "技力不足或施法中" };
      }
      if (intent.kind === "highMove") {
        const unit = battle.units.find((u) => u.id === intent.unitId);
        if (!unit || unit.team !== team) return { ok: false, reason: "不能操作对方单位" };
        const op = operator(unit.opId);
        if (!op.high) return { ok: false, reason: "不是高台干员" };
        if (unit.positionMode !== "high") return { ok: false, reason: "地面行动不可搬运（须撤退后重新上台）" };
        if (unit.highMoveLocked) return { ok: false, reason: "本次在场不可搬运（已下地/地面部署）" };
        if (unit.highMoveCooldown > 0) return { ok: false, reason: "高台搬运冷却中" };
        
        // 费用检查（新增）
        const HIGHMOVE_COST = 3;
        if (battle.cost[team] < HIGHMOVE_COST) return { ok: false, reason: "费用不足" };
        
        if (!Number.isInteger(intent.x) || !Number.isInteger(intent.y)) return { ok: false, reason: "非法高台锚点" };
        if (intent.x < 0 || intent.x >= battle.map.width || intent.y < 0 || intent.y >= battle.map.height) return { ok: false, reason: "非法高台锚点" };
        if (!battle.map.highDeploy(intent.x, intent.y)) return { ok: false, reason: "非法高台锚点" };
        if (!battle.map.inHalf(team, intent.x)) return { ok: false, reason: "只能在己方半场搬运" };
        if (!battle.map.inInitialDeploy(team, intent.x, intent.y)) return { ok: false, reason: "只能在初始部署区搬运" };
        if (battle.units.some((u) => u.id !== unit.id && Math.round(u.x) === intent.x && Math.round(u.y) === intent.y)) {
          return { ok: false, reason: "该位置已有干员" };
        }
        const toNewTile = intent.x !== Math.round(unit.x) || intent.y !== Math.round(unit.y);
        if (!toNewTile) return { ok: false, reason: "原地搬运：位置未变化（不消耗冷却）" };
        
        // 扣除费用（新增）
        battle.cost[team] -= HIGHMOVE_COST;
        
        unit.x = intent.x; unit.y = intent.y; unit.highMoveCooldown = 12;
        unit.facingConfirmed = false;
        log(battle, `${op.name} 已搬运至高台（${intent.x},${intent.y}），消耗 ${HIGHMOVE_COST} 费用`, team === "blue" ? "good" : "bad");
        return { ok: true, unitId: unit.id, facingReselect: true, reason: "搬运成功：可重新确认朝向（一次）" };
      }
      return { ok: false, reason: "未知指令" };
    }

    function snapshot(battle) {
      return {
        started: battle.started,
        mapId: battle.mapId,
        mapName: battle.map ? battle.map.name : "",
        gates: battle.map ? battle.map.gates : null,
        elapsed: Math.round(battle.elapsed * 10) / 10,
        cost: { blue: Math.floor(battle.cost.blue), red: Math.floor(battle.cost.red) },
        gateHp: { blue: battle.gateHp.blue, red: battle.gateHp.red },
        winner: battle.winner,
        exits: (() => { const e = (battle.exits || []).slice(); battle.exits = []; return e; })(),   // 自上次快照以来离场（消费即清）：阵亡/突破=死亡剪辑；撤退/技能退场=收势
        units: battle.units.map((u) => {
          const op = operator(u.opId);
          return {
            id: u.id, opId: u.opId, team: u.team, skillIndex: u.skillIndex || 0,
            x: Math.round(u.x * 100) / 100, y: Math.round(u.y * 100) / 100,
            facing: { x: u.facing.x, y: u.facing.y },        // 四向朝向（上(0,-1)/下(0,1)/左(-1,0)/右(1,0)）
            facingConfirmed: u.facingConfirmed !== false,    // 高台部署/搬运后待确认=false（确认前零输出）
            // S3 可再选向标记：facingConfirmed=false 即可再确认一次（台上单位），供前端发放一次选择机会
            facingSelectAllowed: u.positionMode === "high" && u.facingConfirmed === false,
            hp: Math.round(u.hp), maxHp: u.maxHp,
            routeIndex: u.routeIndex, routeLen: u.route.length,
            lineId: u.lineId || null,                 // 当前行进线路（简化选路）
            routeLocked: !!u.routeLocked,
            marchAllowed: u.positionMode === "ground" && !u.routeLocked && !u.followOf && u.hp > 0 && !battle.winner,
            followOf: u.followOf || null,             // 跟随目标（null=未跟随；领队离场自动解绑）
            skillActive: u.skillActive,
            sp: Math.round(u.sp), spCost: u.spCost,
            // 脚下 SP/持续条真实数据（不伪造：瞬发=0 持续、动作型=打到即收、永久=Infinity→前端画满不倒数）
            // skillActive：技能生效中；skillDurTotal/skillDurLeft 为真实总时长与剩余（秒）。
            skillDurTotal: (() => {
              if (!u.skillActive) return 0;
              const s = skillOf(u);
              return s && s.duration > 0 ? s.duration : (Number.isFinite(u.skillTime) ? u.skillTime : 0);
            })(),
            skillDurLeft: (() => {
              if (!u.skillActive) return 0;
              return Number.isFinite(u.skillTime) ? Math.max(0, Math.round(u.skillTime * 100) / 100) : null;   // null=无限持续（动作型/永久）
            })(),
            blockedBy: u.blockedBy ? 1 : 0,
            highMoveCooldown: Math.ceil(u.highMoveCooldown),
            // 高台/地面双模式快照（界面按钮与服务器状态一致）
            positionMode: u.positionMode,                    // high=台上 | ground=地面/已下地
            descended: !!u.descended,
            shield: Math.round(u.shield || 0),               // 当前护盾（泡/屏障）
            stunned: u.stunUntil > battle.elapsed,           // 眩晕中（动作冻结）
            highMoveAllowed: !!(op.high && u.positionMode === "high" && !u.highMoveLocked),
            stopReason: u.stopReason || "idle",              // moving|following|engaged|healing|casting|blocked|idle
            effDef: Math.round(effDef(battle, u, op)),
            effRes: Math.round(effRes(battle, u, op) * 10) / 10,
            outputMult: Math.round(outMult(battle, u) * 100) / 100,
            retreatable: true,
          };
        }),
        hand: (() => {
          const toSlot = (h) => {
            if (h.type === 'summon') {
              // 召唤物手牌
              return {
                type: 'summon',
                kind: h.kind,
                count: h.count,
                summonerId: h.summonerId,
                config: h.config,
                readyIn: 0,
              };
            }
            // 普通干员手牌
            const op = operator(h.opId);
            if (!op) return null;
            return { opId: h.opId, readyIn: Math.max(0, Math.ceil(h.readyAt - battle.elapsed)), cost: slotDeployCost(op, h) };
          };
          return {
            blue: battle.hand.blue.map(toSlot).filter(Boolean),
            red: battle.hand.red.map(toSlot).filter(Boolean),
          };
        })(),
        summons: battle.summons.map(s => ({
          id: s.id,
          kind: s.kind,
          summonerId: s.summonerId,
          team: s.team,
          x: s.x,
          y: s.y,
          hp: s.hp,
          maxHp: s.maxHp,
          visual: s.visual,
          behavior: s.behavior,
          duration: s.duration,
          spawnedAt: s.spawnedAt,
        })),
        events: battle.events.slice(0, 30),
      };
    }

    return { createBattle, tick, applyIntent, snapshot, operator, MAPS, buildLineRoute, nearestLine, linePath, bfsPath, gridToWorld, normalizeFacing, factionFacing, enemyGates, isEnemyGate };
  }

  const api = { createSim, MAPS, buildLineRoute, nearestLine, linePath, bfsPath, gridToWorld, normalizeFacing, factionFacing, enemyGates, isEnemyGate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AKF_SIM = api;
})(typeof window !== "undefined" ? window : globalThis);

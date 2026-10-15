'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const rooms = new Map();
const sockets = new Map();

// 服务器权威模拟：单位 ID、费用/部署/技能校验、战斗与胜负裁定都在这里
const DATA = require('./public/data.json');
// 地图包：浏览器端由 index.html 的 <script src="maps.js"> 加载；服务端必须同样载入。
// 否则服务端只认识 sim.js 内置的 cross/lanes —— 选图会被判「未知地图」，
// 且所有对局都退化成在 cross 上开打（前端选图与实际战场不一致）。
try {
  globalThis.window = globalThis;                 // maps.js 以 window.AKF_MAPS = {...} 形式导出
  require(path.join(PUBLIC_DIR, 'maps.js'));
} catch (mapsErr) {
  console.error('[warn] failed to load public/maps.js, only built-in maps are available:', mapsErr && mapsErr.message);
}
// 测试专用：缩短蓝门血量以便快速跑完整局（ARK_GATE_HP 环境变量，默认不动玩法）
if (process.env.ARK_GATE_HP) DATA.balance.gateHp = Math.max(1, Number(process.env.ARK_GATE_HP) || DATA.balance.gateHp);
const SIM = require('./public/sim.js').createSim(DATA);

// 服务器持续运行：任何未捕获异常记录后继续服务
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException kept alive:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandledRejection kept alive:', err && err.stack ? err.stack : err);
});

function normalizeRoomId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 16);
}

// 昵称净化：去控制字符/首尾空白，空名回退，上限 16
function sanitizeName(raw, fallback) {
  const cleaned = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 16);
  return cleaned || fallback;
}

function getRoom(rawId) {
  const roomId = normalizeRoomId(rawId);
  if (!roomId) return null;
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      createdAt: Date.now(),
      hostSocketId: null,
      sockets: new Set(),
      players: {},
      battle: { started: false, elapsed: 0, events: [], seq: 0 }
    });
  }
  return rooms.get(roomId);
}

function finalizeDraft(room) {
  const draft = room.draft;
  if (!draft || draft.finalized) return;
  if (draft.picks.blue.length < draft.total || draft.picks.red.length < draft.total) return;
  draft.finalized = true;
  room.simBattle = SIM.createBattle(draft.picks, room.mapId || 'cross');
  room.battle.started = true;
  room.battle.startedAt = Date.now();
  broadcast(room, { type: 'battleStart', serverTime: Date.now(), roomId: room.id, picks: draft.picks });
  broadcast(room, { type: 'snapshot', snapshot: SIM.snapshot(room.simBattle) });
  sendRoom(room);
}

function roomSummary(room) {
  return {
    roomId: room.id,
    hostSocketId: room.hostSocketId,
    players: Object.values(room.players).map((player) => ({
      id: player.id,
      playerId: player.playerId,
      name: player.name,
      team: player.team,
      ready: player.ready,
      picks: player.picks || [],
      online: player.online
    })),
    battle: {
      started: room.battle.started,
      elapsed: room.simBattle ? Math.round(room.simBattle.elapsed * 10) / 10 : 0,
      winner: room.simBattle ? room.simBattle.winner : null,
      units: room.simBattle ? room.simBattle.units.length : 0,
      eventCount: room.simBattle ? room.simBattle.events.length : 0
    },
    draft: room.draft || null
  };
}

function encodeFrame(payload) {
  const data = Buffer.from(payload);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function send(socketId, message) {
  const record = sockets.get(socketId);
  if (record?.socket && !record.socket.destroyed) {
    record.socket.write(encodeFrame(JSON.stringify(message)));
  }
}

function broadcast(room, message, exceptSocketId = null) {
  for (const socketId of room.sockets) {
    if (socketId !== exceptSocketId) send(socketId, message);
  }
}

function sendRoom(room) {
  broadcast(room, { type: 'room', room: roomSummary(room) });
}

function removeSocket(socketId) {
  const record = sockets.get(socketId);
  if (!record) return;
  sockets.delete(socketId);
  if (!record.roomId) return;

  const room = rooms.get(record.roomId);
  if (!room) return;
  room.sockets.delete(socketId);

  const player = room.players[socketId];
  if (player) player.online = false;

  if (room.hostSocketId === socketId) {
    const nextHost = [...room.sockets][0] || null;
    room.hostSocketId = nextHost;
  }
  sendRoom(room);
}

function handleMessage(socketId, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    send(socketId, { type: 'error', message: '消息格式无效。' });
    return;
  }

  const record = sockets.get(socketId);
  if (!record) return;
  record.lastSeen = Date.now();                 // 心跳/活跃时间（闲置回收依据）
  const currentRoom = record.roomId ? rooms.get(record.roomId) : null;

  if (message.type === 'ping') {
    send(socketId, { type: 'pong', serverTime: Date.now() });
    return;
  }

  if (message.type === 'hello') {
    send(socketId, {
      type: 'helloAck',
      socketId,
      playerId: record.playerId,
      serverTime: Date.now(),
      feature: 'prototype',
      rooms: [...rooms.values()].map(roomSummary)
    });
    return;
  }

  if (message.type === 'createRoom' || message.type === 'joinRoom') {
    const requested = message.type === 'createRoom'
      ? String(message.roomId || crypto.randomBytes(2).toString('hex'))
      : message.roomId;
    const room = getRoom(requested);
    if (!room) {
      send(socketId, { type: 'error', message: '房间号只能包含字母和数字。' });
      return;
    }
    if (currentRoom && currentRoom !== room) {
      currentRoom.sockets.delete(socketId);
      if (currentRoom.players[socketId]) currentRoom.players[socketId].online = false;
      sendRoom(currentRoom);
    }

    // —— 参战席严格 2 人：满员拒绝（4/6/8 人仅预留配置）；离线席位可原队回收（断线重连） ——
    const entries = Object.values(room.players);
    const onlineCount = entries.filter((p) => p.online).length;
    const reclaim = entries.find((p) => !p.online);
    if (!room.players[socketId] && onlineCount >= 2 && !reclaim) {
      send(socketId, { type: 'error', message: '房间已满：当前参战席 2 人（多人模式预留中，暂未开放）。' });
      return;
    }

    record.roomId = room.id;
    room.sockets.add(socketId);
    if (!room.hostSocketId || !room.sockets.has(room.hostSocketId)) {
      room.hostSocketId = socketId;
    }

    const teamCount = entries.filter((p) => p.online).length;
    const prior = room.players[socketId] || reclaim;
    if (reclaim && reclaim !== room.players[socketId]) {
      delete room.players[Object.keys(room.players).find((k) => room.players[k] === reclaim)];
    }
    room.players[socketId] = {
      id: socketId,
      playerId: (prior && prior.playerId) || `p_${crypto.randomBytes(4).toString('hex')}`,   // 稳定玩家标识
      name: sanitizeName(message.name, `玩家${teamCount + 1}`),
      team: message.team === 'blue' || message.team === 'red'
        ? message.team
        : (prior && prior.team) || (teamCount % 2 === 0 ? 'blue' : 'red'),
      ready: (prior && prior.ready) || false,
      picks: (prior && prior.picks) || [],
      online: true
    };

    send(socketId, { type: 'joined', roomId: room.id, socketId, host: room.hostSocketId === socketId });
    sendRoom(room);
    return;
  }

  if (!currentRoom) {
    send(socketId, { type: 'error', message: '请先创建或加入房间。' });
    return;
  }

  if (message.type === 'chat') {
    const text = String(message.text || '').trim().slice(0, 240);
    if (!text) return;
    const player = currentRoom.players[socketId];
    broadcast(currentRoom, {
      type: 'chat',
      from: player ? player.name : '系统',
      text,
      at: Date.now()
    });
    return;
  }

  if (message.type === 'ready') {
    const player = currentRoom.players[socketId];
    if (player) {
      player.ready = Boolean(message.ready);
      player.picks = Array.isArray(message.picks) ? message.picks.slice(0, 20) : [];
    }
    sendRoom(currentRoom);
    return;
  }

  if (message.type === 'startBattle') {
    if (currentRoom.hostSocketId !== socketId) {
      send(socketId, { type: 'error', message: '只有房主可以开始。' });
      return;
    }
    // 双方阵营：默认按加入顺序固定（先入=蓝）；ARK_RANDOM_TEAMS=1 时每局随机换边（显式可选）
    const seatPlayers = Object.values(currentRoom.players).filter((p) => p.online);
    if (process.env.ARK_RANDOM_TEAMS && seatPlayers.length >= 2 && Math.random() < 0.5) {
      for (const p of seatPlayers) p.team = p.team === 'blue' ? 'red' : 'blue';
    }
    // 进入服务器权威的交替选人阶段（draftPick 逐条校验，选满自动建局）
    currentRoom.draft = {
      turn: 'blue',
      picks: { blue: [], red: [] },
      total: DATA.balance.draftPickEach || 8,
    };
    broadcast(currentRoom, { type: 'draftStart', draft: currentRoom.draft });
    sendRoom(currentRoom);
    return;
  }

  if (message.type === 'draftPick') {
    const player = currentRoom.players[socketId];
    const draft = currentRoom.draft;
    if (!player || !draft) return;
    const opId = typeof message.opId === 'string' ? message.opId : '';
    const skillIndex = Number.isInteger(message.skillIndex) ? message.skillIndex : 0;
    const opEntry = DATA.operators.find((o) => o.id === opId);
    const taken = (list) => list.some((p) => (p && p.opId === opId) || p === opId);
    let reject = null;
    if (draft.picks.blue.length >= draft.total && draft.picks.red.length >= draft.total) reject = '选人已结束';
    else if (draft.turn !== player.team) reject = '还没轮到你';
    else if (!opEntry) reject = '未知干员';
    else if (taken(draft.picks.blue) || taken(draft.picks.red)) reject = '该干员已被选择';
    else if (skillIndex < 0 || skillIndex > ((opEntry.skills && opEntry.skills.length - 1) || 0)) reject = '非法技能选择';
    else if (draft.picks[player.team].length >= draft.total) reject = '你的阵容已满';
    if (reject) {
      send(socketId, { type: 'draftReject', reason: reject, draft });
      return;
    }
    draft.picks[player.team].push({ opId, skill: skillIndex });
    draft.turn = player.team === 'blue' ? 'red' : 'blue';
    broadcast(currentRoom, { type: 'draft', draft });
    if (draft.picks.blue.length >= draft.total && draft.picks.red.length >= draft.total) {
      setTimeout(() => finalizeDraft(currentRoom), 500);
    }
    return;
  }

  if (message.type === 'setMap') {
    if (currentRoom.hostSocketId !== socketId) {
      send(socketId, { type: 'error', message: '只有房主可以设置地图。' });
      return;
    }
    const mapId = typeof message.mapId === 'string' ? message.mapId : '';
    if (!SIM.MAPS[mapId]) {
      send(socketId, { type: 'error', message: '未知地图。' });
      return;
    }
    currentRoom.mapId = mapId;
    broadcast(currentRoom, { type: 'mapChanged', mapId, mapName: SIM.MAPS[mapId].name });
    sendRoom(currentRoom);
    return;
  }

  if (message.type === 'intent') {
    const player = currentRoom.players[socketId];
    const battle = currentRoom.simBattle;
    if (!player || !battle) return;
    const intent = message.intent && typeof message.intent === 'object' ? message.intent : {};
    // 部署携带技能以选人确认为准：客户端改包传别的技能一律拒绝
    if (intent.kind === 'deploy') {
      const chosen = (battle.skillChoice && battle.skillChoice[intent.opId]) || 0;
      if (Number.isInteger(intent.skillIndex) && intent.skillIndex !== chosen) {
        send(socketId, {
          type: 'intentResult', kind: 'deploy', ok: false, unitId: undefined,
          reason: '技能与选人不符',
        });
        send(socketId, { type: 'snapshot', snapshot: SIM.snapshot(battle) });
        return;
      }
      intent.skillIndex = chosen;
    }
    let result;
    try {
      result = SIM.applyIntent(battle, player.team, intent);
    } catch (err) {
      // 服务器持续运行：非法意图永远得到明确拒绝，不抛穿
      result = { ok: false, reason: `非法指令（${err && err.message ? err.message : '解析失败'}）` };
    }
    send(socketId, {
      type: 'intentResult',
      kind: intent.kind,
      ok: result.ok,
      unitId: result.unitId,
      reason: result.reason,
    });
    if (result.ok) {
      broadcast(currentRoom, { type: 'snapshot', snapshot: SIM.snapshot(battle) });
    } else {
      send(socketId, { type: 'snapshot', snapshot: SIM.snapshot(battle) });
    }
    return;
  }

  if (message.type === 'command') {
    // 旧接口已废弃：不再转发指令，一切以服务器模拟快照为准
    send(socketId, { type: 'error', message: '指令中继已停用，请发送 intent。' });
    return;
  }

  if (message.type === 'leaveRoom') {
    removeSocket(socketId);
    record.roomId = null;
    send(socketId, { type: 'left' });
    return;
  }

  send(socketId, { type: 'error', message: '未知消息类型。' });
}

function safePublicPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const relative = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, sockets: sockets.size, serverTime: Date.now() }));
    return;
  }

  const filePath = safePublicPath(req.url || '/');
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  if (!req.url || !req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));

  const socketId = crypto.randomBytes(8).toString('hex');
  sockets.set(socketId, {
    socket,
    roomId: null,
    buffer: Buffer.alloc(0),
    playerId: `p_${crypto.randomBytes(4).toString('hex')}`,   // 稳定玩家标识（预留队友/归属层）
    lastSeen: Date.now(),
  });
  try { socket.setKeepAlive(true, 30000); } catch { /* 平台不支持时忽略 */ }
  send(socketId, {
    type: 'helloAck',
    socketId,
    serverTime: Date.now(),
    feature: 'prototype',
    rooms: [...rooms.values()].map(roomSummary)
  });

  socket.on('data', (chunk) => {
    const record = sockets.get(socketId);
    if (!record) return;
    record.buffer = Buffer.concat([record.buffer, chunk]);

    while (record.buffer.length >= 2) {
      const first = record.buffer[0];
      const second = record.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (record.buffer.length < 4) return;
        length = record.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (record.buffer.length < 10) return;
        const bigLength = record.buffer.readBigUInt64BE(2);
        if (bigLength > 2n * 1024n * 1024n) {
          socket.destroy();
          return;
        }
        length = Number(bigLength);
        offset = 10;
      }

      const maskLength = masked ? 4 : 0;
      const totalLength = offset + maskLength + length;
      if (record.buffer.length < totalLength) return;

      let payload = record.buffer.subarray(offset + maskLength, totalLength);
      if (masked) {
        const mask = record.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      record.buffer = record.buffer.subarray(totalLength);

      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        const pongHeader = payload.length < 126
          ? Buffer.from([0x8a, payload.length])
          : Buffer.from([0x8a, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
        socket.write(Buffer.concat([pongHeader, payload]));
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x2) continue;
      handleMessage(socketId, payload.toString('utf8'));
    }
  });

  socket.on('error', () => removeSocket(socketId));
  socket.on('close', () => removeSocket(socketId));
});

// 服务器权威推进：50ms 固定步长模拟，10Hz 广播快照，胜负由服务器裁定
let simTickCount = 0;
setInterval(() => {
  const now = Date.now();
  simTickCount += 1;
  for (const room of rooms.values()) {
    if (room.simBattle) {
      const battle = room.simBattle;
      const wasWinner = battle.winner;
      SIM.tick(battle, 0.05);
      if (simTickCount % 2 === 0) {
        broadcast(room, { type: 'snapshot', snapshot: SIM.snapshot(battle) });
      }
      if (battle.winner && !wasWinner) {
        broadcast(room, { type: 'battleEnd', winner: battle.winner, snapshot: SIM.snapshot(battle) });
      }
      room.battle.elapsed = now - room.battle.startedAt;
    }
    if (room.sockets.size === 0 && now - room.createdAt > 12 * 60 * 60 * 1000) {
      rooms.delete(room.id);
    }
  }
  // 联机维护：闲置连接回收（10 分钟无任何消息含 ping）→ 释放参战席，供断线重连/他人加入
  for (const [sid, rec] of sockets) {
    if (now - (rec.lastSeen || now) > 10 * 60 * 1000) {
      try { rec.socket.destroy(); } catch { /* 已断开 */ }
      sockets.delete(sid);
      const room = rec.roomId ? rooms.get(rec.roomId) : null;
      if (room) {
        room.sockets.delete(sid);
        if (room.players[sid]) room.players[sid].online = false;
        sendRoom(room);
      }
    }
  }
}, 50);

// 端口占用：明确报错并退出（否则进程会“活着但没在监听”，让人以为启动成功了）
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[ERROR] Port ${PORT} is already in use.`);
    console.error('        Another ArkFights server (or another program) is using it.');
    console.error('        Either close that window, or start on another port:');
    console.error(`            set PORT=${PORT + 1}`);
    console.error('            start-game.bat');
    console.error('');
    process.exit(1);
    return;
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  // 真实局域网地址：排除 WSL / VMware / VirtualBox / Hyper-V / Docker 等虚拟网卡，
  // 它们给出的地址对手连不上，混在一起会让人不知道分享哪个。
  const VIRTUAL = /(wsl|vmware|virtualbox|vbox|hyper-v|docker|loopback|tailscale|zerotier|radmin|npcap|bluetooth)/i;
  const real = [];
  const virtual = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      (VIRTUAL.test(name) ? virtual : real).push({ name, address: entry.address });
    }
  }
  console.log('ArkFights server running.');
  console.log('');
  console.log(`  Local :  http://127.0.0.1:${PORT}`);
  if (real.length) {
    console.log('  LAN   :  share one of these with your opponent (same Wi-Fi):');
    for (const a of real) console.log(`             http://${a.address}:${PORT}      [${a.name}]`);
  } else {
    console.log('  LAN   :  no physical LAN address found; use 127.0.0.1 for local play.');
  }
  if (virtual.length) {
    console.log('  (ignore these virtual adapters)');
    for (const a of virtual) console.log(`             http://${a.address}:${PORT}      [${a.name}]`);
  }
  console.log('');
  console.log('  Stop  :  press Ctrl+C');
  console.log('  This project only serves its own files and never writes to the Arknights installation.');
});

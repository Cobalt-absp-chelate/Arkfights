// ArkFights client — server-authoritative: renders snapshots, sends intents.
// Battle math lives in public/sim.js (server-裁定); the browser never decides combat.
(() => {
  "use strict";

  const DATA = window.ARKFIGHTS_DATA;
  const OPS = DATA.operators;
  const PROJ = window.AKF_PROJECTION;
  const SIM = window.AKF_SIM;
  const SKILL_CONTROLS = window.AKF_SKILL_CONTROLS || {};

  const $ = (id) => document.getElementById(id);
  const canvas = $("battleCanvas");
  const ctx = canvas.getContext("2d");
  const unitCanvas = $("unitCanvas");
  const fxCanvas = $("fxCanvas");
  initAmbientCanvas();   // 环境动画画布（map-animations.js）
  let frameDt = 1 / 60;  // 本帧 dt（供占位单位的步态动画使用）
  const fxCtx = fxCanvas.getContext("2d");
  const occCanvas = $("occCanvas");
  const occCtx = occCanvas ? occCanvas.getContext("2d") : null;
  if (occCanvas) {
    occCanvas.style.position = "absolute";
    occCanvas.style.inset = "0";
    occCanvas.style.pointerEvents = "none";
  }

  const TEAM_COLOR = { blue: "#54b8ff", red: "#ff5a5a" };
  // 真实职业图标（原作 arts/profession_large_hub）：中文职业 → 文件名
  const CLASS_ICON = {
    "先锋": "pioneer", "近卫": "warrior", "重装": "tank", "狙击": "sniper",
    "术师": "caster", "医疗": "medic", "辅助": "support", "特种": "special",
  };
  // 立绘逐图面部锚点（生成脚本 生成）：选人卡/图鉴不裁头
  const ART_ANCHORS = {};
  fetch("assets/art/anchors.json").then((r) => r.json()).then((a) => Object.assign(ART_ANCHORS, a)).catch(() => {});
  const TILE_W = 60;
  const TILE_H = 640 / 12;
  let MAP_W = 16;
  let MAP_H = 12;

  function operator(id) { return OPS.find((o) => o.id === id); }

  const state = {
    socket: null,
    socketId: null,
    roomId: "",
    room: null,
    host: false,
    team: "blue",
    screen: "loading",
    draft: { turn: "blue", picks: { blue: [], red: [] }, total: DATA.balance.draftPickEach },
    view: null,          // 权威快照视图
    localSim: null,      // 演示模式本地模拟（与服务器同一 sim.js）
    localBattle: null,
    selectedUnitId: null,
    selectedOpId: null,
    routeDraft: [],
    highTarget: null,
    highMoveMode: false,  // 是否处于搬运模式（需要先点按钮）
    descendTarget: null,
  };

  // ---------------- 加载页 ----------------
  function runLoading() {
    const bar = $("loadBar"), percent = $("loadPercent"), text = $("loadText");
    const steps = [
      [8, "正在校验战术数据"], [24, "正在建立神经网络连接"], [42, "正在同步 PRTS 作战终端"],
      [61, "正在进行干员数据检索"], [78, "正在校准罗德岛移动城市坐标"],
      [93, "神经网络连接完成"], [100, "欢迎回来，博士"],
    ];
    let i = 0;
    const timer = setInterval(() => {
      const [p, label] = steps[i];
      bar.style.width = `${p}%`;
      percent.textContent = p;
      text.textContent = label;
      i += 1;
      if (i >= steps.length) {
        clearInterval(timer);
        setTimeout(() => {
          // 仅当仍停留在加载页时才自动进入主页（防止覆盖已进入的选人/战场）
          if (state.screen === "loading") switchScreen("home");
        }, 480);
      }
    }, 400);
  }

  function switchScreen(name) {
    state.screen = name;
    state.screenLog = (state.screenLog || []).concat(`${Date.now() % 100000}:${name}`).slice(-8);
    for (const [key, id] of Object.entries({
      loading: "loadingScreen", home: "homeScreen", room: "roomScreen",
      draft: "draftScreen", battle: "battleScreen",
      gallery: "rosterScreen", config: "configScreen", guide: "guideScreen",
    })) {
      const hide = key !== name;
      if ($(id).classList.contains("hidden") !== hide) $(id).classList.toggle("hidden", hide);
    }
    if (name === "draft") renderDraft();
    if (name === "battle") renderHand();
  }

  // ---------------- 联机 ----------------
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    state.socket = socket;
    socket.addEventListener("open", () => {
      $("connText").textContent = "已连接";
      $("homeStatus").textContent = "作战终端已连接 // 可以创建或加入房间";
      send({ type: "hello" });
    });
    socket.addEventListener("message", (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg);
    });
    socket.addEventListener("close", () => {
      $("connText").textContent = "断开，3秒后重连";
      setTimeout(connect, 3000);
    });
  }

  function send(msg) {
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(msg));
  }

  function sendIntent(intent) { send({ type: "intent", intent }); }

  function handleMessage(msg) {
    if (msg.type === "helloAck") {
      state.socketId = msg.socketId;
      const q = new URLSearchParams(location.search).get("room");
      if (q) $("roomInput").value = q;
      return;
    }
    if (msg.type === "joined") {
      state.roomId = msg.roomId;
      state.host = msg.host;
      $("roomTitle").textContent = `ROOM // ${msg.roomId}`;
      $("roomStatus").textContent = `已进入房间 ${msg.roomId}${msg.host ? "（你是房主）" : ""}`;
      switchScreen("room");
      return;
    }
    if (msg.type === "room") {
      state.room = msg.room;
      const me = msg.room.players.find((p) => p.id === state.socketId);
      if (me) state.team = me.team;
      state.host = msg.room.hostSocketId === state.socketId;
      // 选人同步：双方 picks 通过 room 广播互见
      const blue = msg.room.players.find((p) => p.team === "blue");
      const red = msg.room.players.find((p) => p.team === "red");
      if (msg.room.draft) {
        state.draft = {
          turn: msg.room.draft.turn,
          picks: { blue: msg.room.draft.picks.blue.slice(), red: msg.room.draft.picks.red.slice() },
          total: msg.room.draft.total,
        };
      }
      renderRoom();
      return;
    }
    if (msg.type === "draftStart" || msg.type === "draft") {
      const d = msg.draft;
      state.draft = {
        turn: d.turn,
        picks: { blue: d.picks.blue.slice(), red: d.picks.red.slice() },
        total: d.total,
      };
      // 对局进行中忽略滞后选人消息；对局已结束（结算卡状态）收到新选人阶段则双方都要切屏（此前非房主卡在战场页）
      const battleOver = state.screen === "battle" && state.view && state.view.winner;
      if (state.screen !== "battle" || battleOver) {
        if (state.resultShown) hideResult();
        switchScreen("draft");
      }
      return;
    }
    if (msg.type === "draftReject") {
      log(`选人被拒绝：${msg.reason}`, "bad");
      $("draftCount").textContent = `拒绝：${msg.reason}`;
      return;
    }
    if (msg.type === "battleStart") {
      state.view = {
        units: [], hand: { blue: [], red: [] },
        cost: { blue: DATA.balance.costStart, red: DATA.balance.costStart },
        gateHp: { blue: DATA.balance.gateHp, red: DATA.balance.gateHp },
        elapsed: 0, winner: null, events: [], picks: msg.picks,
      };
      state.selectedOpId = (() => {
        const first = msg.picks && msg.picks[state.team] && msg.picks[state.team][0];
        return (first && first.opId) || first || OPS[0].id;
      })();
      hideResult();
      switchScreen("battle");
      log("作战开始：拖动卡片部署，选定线路后开始行军。", "sys");
      renderHand();
      return;
    }
    if (msg.type === "snapshot" || msg.type === "battleEnd") {
      applySnapshot(msg.snapshot);
      if (msg.type === "battleEnd") {
        log(msg.winner === state.team ? "作战胜利：敌方蓝门已被攻破！" : "作战失败：己方蓝门陷落。", msg.winner === state.team ? "good" : "bad");
        showResult(msg.snapshot, msg.winner);
      }
      return;
    }
    if (msg.type === "mapChanged") {
      state.mapId = msg.mapId;
      markMapSelection();
      log(`作战地图：${msg.mapName}`, "sys");
      return;
    }
    if (msg.type === "intentResult" && !msg.ok) {
      state.pendingDeploy = null;
      log(`操作被拒绝：${msg.reason || "无效操作"}`, "bad");
      return;
    }
    if (msg.type === "intentResult" && msg.ok && msg.unitId) {
      state.selectedUnitId = msg.unitId;
      updateUnitInfo();
      return;
    }
    if (msg.type === "error") $("roomStatus").textContent = msg.message;
  }

  function applySnapshot(snap) {
    if (!snap) return;
    const previousMode = selectedUnit()?.positionMode;
    feedEffects(snap);   // HP 变化 → 飘字/受击闪光/弹道（真实伤害事件驱动）
    state.view = snap;
    renderHand();        // 快照驱动 UI 刷新（不单依赖帧循环：后台标签 rAF 被暂停时仍实时）
    updateUnitInfo();
    if (state.pendingDeploy) {
      const deployed = snap.units.find((u) => u.team === state.team && u.opId === state.pendingDeploy.opId);
      if (deployed) { state.pendingDeploy = null; selectBattleUnit(deployed); }
    }
    const nowSelected = selectedUnit();
    if (previousMode === "high" && nowSelected?.positionMode === "ground" && nowSelected.marchAllowed) ROUTE.beginMarch(nowSelected);
    if (state.selectedUnitId && !snap.units.some((u) => u.id === state.selectedUnitId)) {
      state.selectedUnitId = null;
      ROUTE.clearDraft();
    }
    if (state.highTarget && !snap.units.some((u) => u.id === state.highTarget)) state.highTarget = null;
    if (state.descendTarget && !snap.units.some((u) => u.id === state.descendTarget)) state.descendTarget = null;
  }

  // ---------------- 主页 / 房间 ----------------
  function renderRoom() {
    const wrap = $("roomPlayers");
    if (!state.room) return;
    wrap.innerHTML = state.room.players.map((p) => `
      <div class="roomPlayer ${p.team === "red" ? "red" : ""}">
        <strong>${p.name}${p.id === state.socketId ? "（你）" : ""}</strong>
        <span class="tag">${p.team === "red" ? "红方 RED" : "蓝方 BLUE"} · 已选 ${((p.picks || []).length)}/8${p.online ? "" : " · 离线"}</span>
      </div>
    `).join("");
    $("roomStartButton").disabled = !state.host;
    $("roomReadyButton").textContent = "确认阵容";
  }

  $("createRoomButton").addEventListener("click", () => send({ type: "createRoom", roomId: $("roomInput").value, name: $("nameInput").value }));
  $("joinRoomButton").addEventListener("click", () => send({ type: "joinRoom", roomId: $("roomInput").value, name: $("nameInput").value }));
  $("quickStartButton").addEventListener("click", () => send({ type: "createRoom", roomId: $("roomInput").value, name: $("nameInput").value }));
  $("copyLinkButton").addEventListener("click", async () => {
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent($("roomInput").value)}`;
    try { await navigator.clipboard.writeText(link); $("homeStatus").textContent = "邀请链接已复制"; }
    catch { $("homeStatus").textContent = link; }
  });
  $("roomReadyButton").addEventListener("click", () => {
    switchScreen("draft");
    renderDraft();
  });
  $("roomStartButton").addEventListener("click", () => {
    // 房主点“开始战斗”→ 服务器开启交替选人阶段
    send({ type: "startBattle" });
    switchScreen("draft");
    renderDraft();
  });
  // 地图卡片点击→整图预览（选择在预览内确认，见下方 mapPreview 块）
  $("roomLeaveButton").addEventListener("click", () => {
    send({ type: "leaveRoom" });
    switchScreen("home");
  });

  // ---------------- 交替选人（双方 picks 经 room 同步，服务器最终裁定） ----------------
  function renderDraft() {
    // 同一选人状态不重复全量重建（20 卡×图片重解码会拖住输入通道）；状态变化才重建
    window.__DRAFT_DIAG__ = window.__DRAFT_DIAG__ || { calls: 0, builds: 0, skips: 0 };
    window.__DRAFT_DIAG__.calls += 1;
    const sig = JSON.stringify([state.draft, state.preselect, state.room && state.room.players.map((p) => [p.team, p.name])]);
    if (renderDraft._sig === sig) { window.__DRAFT_DIAG__.skips += 1; return; }
    renderDraft._sig = sig;
    window.__DRAFT_DIAG__.builds += 1;
    const d = state.draft;
    const myTurn = d.turn === state.team;
    const pickId = (p) => (p && typeof p === "object" ? p.opId : p);
    const pickSkill = (p) => (p && typeof p === "object" && Number.isInteger(p.skill) ? p.skill : 0);

    $("draftTurn").textContent = myTurn ? "轮到你选择干员与携带技能" : `等待${d.turn === "blue" ? "蓝方" : "红方"}选择…`;
    $("draftCount").textContent = `蓝 ${d.picks.blue.length} : ${d.picks.red.length} 红`;
    if (state.room) {
      $("draftBlueName").textContent = state.room.players.find((p) => p.team === "blue")?.name || "蓝方";
      $("draftRedName").textContent = state.room.players.find((p) => p.team === "red")?.name || "红方";
    }
    $("draftCap").textContent = `${d.picks[state.team].length}/${d.total}`;

    // 双方阵容槽位（原作编队斜切卡）
    const slotHtml = (p, team) => {
      if (!p) return '<div class="squadEmpty"></div>';
      const op = operator(pickId(p));
      const skills = (op.skills && op.skills.length ? op.skills : [op.skill]);
      return `
        <div class="squadCard ${team}">
          <img src="assets/avatars/${op.id}.webp" alt="${op.name}">
          <div class="scMeta"><img class="scClass" src="assets/class/${CLASS_ICON[op.role] || "warrior"}.png" alt="">${op.role} · COST ${op.cost} · LV.80</div>
          <div class="scSkills">${skills.map((s, i) => `<i class="${i === pickSkill(p) ? "on" : ""}" title="${s.name || ""}">${s.id ? `<img src="assets/skills/skill_icon_${s.id}.webp" alt="" onerror="this.replaceWith(document.createTextNode('${i + 1}'))">` : (i + 1)}</i>`).join("")}<em>${(skills[pickSkill(p)] || skills[0]).name || ""}</em></div>
          <div class="scName">${op.name}</div>
        </div>`;
    };
    const slots = (list, team) => {
      const arr = [];
      for (let i = 0; i < d.total; i += 1) arr.push(slotHtml(list[i], team));
      return arr.join("");
    };
    $("draftBluePicks").innerHTML = slots(d.picks.blue, "blue");
    $("draftRedPicks").innerHTML = slots(d.picks.red, "red");

    // 预选面板（固定醒目区）：头像/职业/名称 + 携带技能图标/名称/说明/SP/持续
    const pre = state.preselect;
    const preOp = pre ? operator(pre.opId) : null;
    const spTypeName = (t) => String(t || "").includes("ATTACK") ? "攻击回复" : String(t || "").includes("TAKEN_DAMAGE") ? "受击回复" : "自动回复";
    if (preOp) {
      const s = (preOp.skills && preOp.skills[pre.skill]) || preOp.skill;
      $("draftPrePanel").innerHTML = `
        <img class="ppAvatar" src="assets/avatars/${preOp.id}.webp" alt="">
        <div class="ppMeta">
          <b>${preOp.name}</b>
          <small>${preOp.role} · ${preOp.high ? "高台" : "地面"} · 阻挡 ${preOp.block} · COST ${preOp.cost} · 再部署 ${preOp.redeployTime}s</small>
          <div class="ppSkill">
            ${s.id ? `<img src="assets/skills/skill_icon_${s.id}.webp" alt="" onerror="this.remove()">` : '<i class="ppNoIcon">图标缺失</i>'}
            <div>
              <b>${s.name || "技能"}</b>
              <small>${spTypeName(s.spType)} · 初始 ${s.initialSp || 0} · 消耗 ${s.spCost || "—"} · 持续 ${s.duration || "—"}s</small>
              <p>${s.desc || ""}</p>
            </div>
          </div>
        </div>`;
    } else {
      $("draftPrePanel").innerHTML = '<span class="ppEmpty">点击干员卡预选 · 点击技能图标切换携带技能</span>';
    }
    $("draftHint").textContent = !myTurn
      ? `等待${d.turn === "blue" ? "蓝方" : "红方"}确认…`
      : pre
        ? "点击【确认选择】锁定该干员与技能"
        : "点击干员卡预选 · 点击技能图标切换携带技能";

    // 共享干员池（真实立绘逐图面部锚点 + 真实技能图标）：
    // 大池（数百干员）只建一次 DOM，状态变化增量更新（占用/预选/技能按钮），避免全量重建拖死输入
    const blueIds = d.picks.blue.map(pickId);
    const redIds = d.picks.red.map(pickId);
    const roster = $("draftRoster");
    if (!renderDraft._cards) {
      renderDraft._cards = new Map();
      // 池排序：职业分类（先锋→特种）+ 职业内星级降序 + 名称
      const ROLE_ORDER = { "先锋": 0, "近卫": 1, "重装": 2, "狙击": 3, "术师": 4, "医疗": 5, "辅助": 6, "特种": 7 };
      const sorted = [...OPS].sort((a, b) =>
        (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)
        || (b.rarity || 0) - (a.rarity || 0)
        || String(a.name).localeCompare(String(b.name), "zh"));
      const cardHtml = (op) => {
        const skills = (op.skills && op.skills.length ? op.skills : [op.skill]);
        const anchor = ART_ANCHORS[op.id];
        const pos = anchor ? `object-position:50% ${(anchor.cardFaceY * 100).toFixed(1)}%;` : "object-position:50% 10%;";
        return `
        <article class="poolCard" data-id="${op.id}">
          <div class="ribbon" style="display:none">蓝方</div>
          <img src="assets/art/${op.id}_card.webp" alt="" style="${pos}" loading="lazy">
          <div class="pcMeta"><img class="pcClass" src="assets/class/${CLASS_ICON[op.role] || "warrior"}.png" alt="" loading="lazy">${"★".repeat(op.rarity)} · COST ${op.cost} · ${op.high ? "高台" : "地面"}</div>
          <div class="pcName">${op.name}</div>
          <div class="pcRole">${op.role} · 阻挡 ${op.block} · 攻击目标 ${op.atkTargets || 1}</div>
          <div class="pcSkills">${skills.map((s, i) => `
            <button class="skBtn ${s.id ? "" : "noIcon"}" data-id="${op.id}" data-skill="${i}" title="${s.name || ""}（${s.skillType === "AUTO" ? "自动触发：SP 满自动发动" : s.skillType === "PASSIVE" ? "被动" : "手动触发：E 发动"}）">
              ${s.id ? `<img src="assets/skills/skill_icon_${s.id}.webp" alt="" loading="lazy" onerror="this.remove()">` : ""}
              <span>${s.name || `技能${i + 1}`}<em style="font-style:normal;opacity:.78;font-size:10px;margin-left:4px">${s.skillType === "AUTO" ? "自动" : s.skillType === "PASSIVE" ? "被动" : "手动·E"}</em></span>
            </button>`).join("")}</div>
        </article>`;
      };
      const roleCount = {};
      for (const op of sorted) roleCount[op.role] = (roleCount[op.role] || 0) + 1;
      // 窗口化渲染：数百卡全量 DOM 会拖死选人页输入通道 → 每段 60 张、滚到底自动续建；
      // 筛选/搜索在已建卡上生效并自动续建补足，全池可达（不翻页/不跳转）
      renderDraft._sorted = sorted;
      renderDraft._built = 0;
      renderDraft._chunk = 60;
      renderDraft._buildChunk = () => {
        const start = renderDraft._built;
        const end = Math.min(start + renderDraft._chunk, sorted.length);
        if (end <= start) return;
        let html = "";
        for (let i = start; i < end; i += 1) {
          const op = sorted[i];
          if (i === 0 || sorted[i - 1].role !== op.role) {
            html += `<div class="poolGroup">${op.role} <small>${roleCount[op.role]} 名 · 星级↓</small></div>`;
          }
          html += cardHtml(op);
        }
        const frag = document.createElement("div");
        frag.innerHTML = html;
        const bindCard = (card) => {
          renderDraft._cards.set(card.dataset.id, card);
          card.addEventListener("click", () => {
            if (card.classList.contains("taken")) return;
            const opId = card.dataset.id;
            const skill = state.preselect && state.preselect.opId === opId ? state.preselect.skill : 0;
            state.preselect = { opId, skill };
            renderDraft();
          });
          card.querySelectorAll(".pcSkills button").forEach((btn) => {
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              state.preselect = { opId: btn.dataset.id, skill: Number(btn.dataset.skill) };
              renderDraft();
            });
          });
        };
        while (frag.firstChild) {
          const node = frag.firstChild;
          frag.removeChild(node);
          roster.appendChild(node);
          if (node.nodeType === 1 && node.classList && node.classList.contains("poolCard")) bindCard(node);
        }
        renderDraft._built = end;
        if (window.applyPoolFilter) window.applyPoolFilter();
      };
      renderDraft._buildChunk();
      roster.addEventListener("scroll", () => {
        if (roster.scrollTop + roster.clientHeight > roster.scrollHeight - 700) renderDraft._buildChunk();
      }, { passive: true });
      // —— 职业筛选（吸顶八职业）+ 姓名搜索：增量显隐，不重建 DOM ——
      renderDraft._applyFilter = window.applyPoolFilter;
      state.poolFilter = state.poolFilter || "all";
      state.poolQuery = state.poolQuery || "";
    }
    if (window.applyPoolFilter) window.applyPoolFilter();
    // 增量状态更新：占用归属 / 预选高亮 / 携带技能按钮
    for (const [opId, card] of renderDraft._cards) {
      const inBlue = blueIds.includes(opId);
      const inRed = redIds.includes(opId);
      const taken = inBlue || inRed;
      card.classList.toggle("taken", taken);
      card.classList.toggle("preselect", !!pre && pre.opId === opId);
      const ribbon = card.querySelector(".ribbon");
      ribbon.style.display = taken ? "" : "none";
      ribbon.textContent = inBlue ? "蓝方" : "红方";
      ribbon.classList.toggle("red", inRed);
      const preSkill = pre && pre.opId === opId ? pre.skill : -1;
      card.querySelectorAll(".pcSkills button").forEach((b) => {
        b.classList.toggle("on", Number(b.dataset.skill) === preSkill);
      });
    }

    const full = d.picks[state.team].length >= d.total;
    const canConfirm = myTurn && !!pre && !full;
    $("draftConfirmButton").disabled = !canConfirm;
    $("draftActionLabel").textContent = full
      ? "服务器建局中"
      : myTurn ? (pre ? "确认选择" : "等待预选") : "等待对方选择";
  }

  function tryPick(opId, skillIndex) {
    // 轮次/重复/上限/技能合法性都在服务器校验；客户端只发意图
    state.preselect = null;
    send({ type: "draftPick", opId, skillIndex: skillIndex || 0 });
    renderDraft();
  }

  // —— 职业筛选 + 姓名搜索（加载时绑定一次，与渲染生命周期解耦）——
  state.poolFilter = "all";
  state.poolQuery = "";
  window.applyPoolFilter = () => {
    const cards = renderDraft._cards;
    if (!cards) return;
    const q = String(state.poolQuery || "").trim().toLowerCase();
    for (const [opId, card] of cards) {
      const op = operator(opId);
      const okRole = state.poolFilter === "all" || (op && op.role === state.poolFilter);
      const okName = !q || (op && String(op.name).toLowerCase().includes(q)) || String(opId).toLowerCase().includes(q);
      card.style.display = okRole && okName ? "" : "none";
    }
    document.querySelectorAll("#draftRoster .poolGroup").forEach((hdr) => {
      let n = 0;
      let el = hdr.nextElementSibling;
      while (el && !el.classList.contains("poolGroup")) {
        if (el.classList.contains("poolCard") && el.style.display !== "none") n += 1;
        el = el.nextElementSibling;
      }
      hdr.style.display = n ? "" : "none";
    });
    // 筛选/搜索时自动续建补足可见卡（窗口化渲染下保证全池可达；滚动仍可继续）
    if ((q || state.poolFilter !== "all") && renderDraft._buildChunk && window.__POOL_GROWING__ !== true) {
      window.__POOL_GROWING__ = true;
      const grow = () => {
        let visible = 0;
        for (const [, c] of cards) if (c.style.display !== "none") visible += 1;
        const total = (renderDraft._sorted || []).length;
        if (visible < 120 && renderDraft._built < total) {
          renderDraft._buildChunk();
          setTimeout(grow, 0);
        } else {
          window.__POOL_GROWING__ = false;
        }
      };
      setTimeout(grow, 0);
    }
  };
  document.querySelectorAll("#poolTabs .poolTab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#poolTabs .poolTab").forEach((t) => t.classList.remove("on"));
      tab.classList.add("on");
      state.poolFilter = tab.dataset.role || "all";
      window.applyPoolFilter();
    });
  });
  if ($("poolSearch")) {
    $("poolSearch").addEventListener("input", () => {
      state.poolQuery = $("poolSearch").value || "";
      window.applyPoolFilter();
    });
  }

  $("draftConfirmButton").addEventListener("click", () => {
    const pre = state.preselect;
    if (!pre) return;
    // 教程模式：本地选人（无房间/服务器；选满由教程推进到战斗）
    if (window.AKF_TUTORIAL && window.AKF_TUTORIAL.active && window.AKF_TUTORIAL.phase === "draft" && !state.room) {
      state.draft.picks.blue.push({ opId: pre.opId, skill: pre.skill });
      state.preselect = null;
      renderDraft();
      if (window.AKF_TUTORIAL_HOST && state.draft.picks.blue.length >= 2) {
        window.AKF_TUTORIAL.onPicked(window.AKF_TUTORIAL_HOST);
      }
      return;
    }
    tryPick(pre.opId, pre.skill);
  });

  // ---------------- 战斗：意图 ----------------
  function selectedUnit() {
    return state.view && state.view.units.find((u) => u.id === state.selectedUnitId);
  }

  function battleIntent(intent) {
    if (state.localBattle) {
      const result = state.localSim.applyIntent(state.localBattle, state.team, intent);
      if (!result.ok) log(result.reason || "操作无法执行", "bad");
      applySnapshot(state.localSim.snapshot(state.localBattle));
      return result;
    }
    sendIntent(intent);
    return { ok: true, pending: true };
  }

  function selectBattleUnit(unit) {
    state.selectedUnitId = unit ? unit.id : null;
    state.selectedOpId = null;
    state.highTarget = null;
    state.descendTarget = null;
    state.unitTab = "skill";
    ROUTE.clearDraft();
    if (unit && unit.team === state.team && unit.marchAllowed) ROUTE.beginMarch(unit);
    updateUnitInfo();
    ROUTE.renderFollowBadge();
    renderHand();
    if (unit) canvas.focus({ preventScroll: true });
  }

  function deployAt(opId, tile) {
    const op = operator(opId), view = state.view, map = currentMap();
    const slot = view && view.hand[state.team].find((h) => h.opId === opId);
    if (!op || !slot || !tile) return false;
    if (state.pendingDeploy) return false;
    if (view.units.some((u) => u.team === state.team && u.opId === opId)) { log("该干员已在场上", "bad"); return false; }
    if (slot.readyIn > 0) { log("干员仍在再部署冷却中", "bad"); return false; }
    if (!map.inHalf(state.team, tile.x) || !inInitialZone(tile.x, tile.y) || !(op.high ? map.highDeploy(tile.x, tile.y) || map.groundDeploy(tile.x, tile.y) : map.groundDeploy(tile.x, tile.y))) { log("请选择己方初始部署区内地块", "bad"); return false; }
    const cost = slot.cost == null ? op.cost : slot.cost;
    if (view.cost[state.team] < cost) { log("部署费用不足", "bad"); return false; }
    if (view.units.some((u) => Math.round(u.x) === tile.x && Math.round(u.y) === tile.y)) { log("该位置已有干员", "bad"); return false; }
    const result = battleIntent({ kind: "deploy", opId, route: [{ x: tile.x, y: tile.y }] });
    if (!result.ok) return false;
    state.selectedOpId = null;
    if (result.pending) state.pendingDeploy = { opId, x: tile.x, y: tile.y };
    else selectBattleUnit(state.view.units.find((u) => u.id === result.unitId));
    renderHand();
    return true;
  }

  function confirmRoute() {
    const unit = selectedUnit();
    if (!unit || unit.team !== state.team || !unit.marchAllowed || !ROUTE.draftStart || !state.routeDraft.length) return;
    // 高级自定义线路：终点必须=敌方门格才有效（否则不可确认，继续划线）
    if (ROUTE.customPath.length > 1 && !ROUTE.customAtGate()) {
      log("高级自定义线路必须以敌方门为终点才可出发（把线划到敌方门格）", "bad");
      return;
    }
    // march 意图=完整 waypoints（相邻逐格=BFS 原样走）；服务器途经点上限 64：超限只发合法前缀（文档写明）
    let wps = ROUTE.waypoints.slice();
    if (wps.length > 64) {
      log(`自定义线路 ${wps.length} 格超过途经点上限 64：已发前 64 格（合法前缀），其余段由所选线路补完到门`, "sys");
      wps = wps.slice(0, 64);
    }
    const result = battleIntent({ kind: "march", unitId: unit.id, line: ROUTE.lineId, waypoints: wps });
    if (result.ok) ROUTE.clearDraft();
    updateUnitInfo();
    renderHand();
  }

  // 跟随系统：按住模型拖到己方干员松手建立跟随（targetId=null 解除）；服务器权威校验
  function sendFollow(unitId, targetId) {
    const intent = { kind: "follow", unitId, targetId };
    if (state.localSim && state.localBattle) {
      const r = state.localSim.applyIntent(state.localBattle, state.team, intent);
      if (!r.ok) log(`跟随被拒绝：${r.reason}`, "bad");
    } else {
      sendIntent(intent);
    }
  }

  function activateSelectedSkill() {
    const unit = selectedUnit();
    if (!unit || unit.team !== state.team || !manualSkill(unit) || unit.skillActive || unit.sp < unit.spCost) return;
    if (state.localBattle) {
      const r = state.localSim.applyIntent(state.localBattle, state.team, { kind: "skill", unitId: unit.id });
      if (!r.ok) log(`操作被拒绝：${r.reason}`, "bad");
    } else {
      sendIntent({ kind: "skill", unitId: unit.id });
    }
    updateUnitInfo();
  }

  function carriedSkill(unit) {
    const op = operator(unit.opId);
    return (op.skills && op.skills[unit.skillIndex || 0]) || op.skill;
  }
  function manualSkill(unit) {
    return (SKILL_CONTROLS[carriedSkill(unit)?.id]?.trigger || "MANUAL") === "MANUAL";
  }
  function descendTiles(unit) {
    if (!unit || unit.positionMode !== "high") return [];
    const m = currentMap(), x = Math.round(unit.x), y = Math.round(unit.y);
    return [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]
      .map(([x,y])=>({x,y}))
      .filter((t)=>
        t.x>=0 && t.y>=0 && t.x<m.width && t.y<m.height &&
        m.inHalf(unit.team, t.x) &&  // 己方半场（与sim判定同源）
        m.groundDeploy(t.x,t.y) && m.routable(t.x,t.y) &&
        !state.view.units.some((u)=>u.id!==unit.id&&Math.round(u.x)===t.x&&Math.round(u.y)===t.y)
      );
  }

  function requestHighMove() {
    const unit = selectedUnit();
    const op = unit && operator(unit.opId);
    if (!unit || unit.team !== state.team || !op?.high || !unit.highMoveAllowed || unit.highMoveCooldown > 0) return;
    
    // 检查费用
    const HIGHMOVE_COST = 3;
    const currentCost = state.view ? state.view.cost[state.team] : 99;
    if (currentCost < HIGHMOVE_COST) {
      log(`高台搬运费用不足（需要 ${HIGHMOVE_COST}，当前 ${currentCost}）`, "bad");
      return;
    }
    
    state.highTarget = unit.id;
    state.highMoveMode = true;  // 进入搬运模式
    state.descendTarget = null;
    log("高台搬运：拖动干员到目标高台锚点（消耗3费用，冷却12秒）", "sys");
  }

  function moveHighUnit(unitId, tile) {
    if (state.localBattle) {
      const r = state.localSim.applyIntent(state.localBattle, state.team, { kind: "highMove", unitId, x: tile.x, y: tile.y });
      if (!r.ok) log(`操作被拒绝：${r.reason}`, "bad");
    } else {
      sendIntent({ kind: "highMove", unitId, x: tile.x, y: tile.y });
    }
  }

  // ---------------- 战斗：输入（原作关卡视角投影） ----------------
  PROJ.setViewport(canvas.width, canvas.height);
  function battleCam() {
    // 相机尺寸/地图维度出自地图配置；小地图平移只改本地视野（世界坐标/射程/时间不动）
    const m = currentMap();
    MAP_W = m.width; MAP_H = m.height;
    const handHeight = document.querySelector(".btHand")?.getBoundingClientRect().height || 145;
    const topHeight = document.querySelector(".btTop")?.getBoundingClientRect().height || 62;
    const cam = PROJ.cameraFor(state.team, m.width, m.height, {
      preset: state.cameraPreset || "default",
      viewport: { x: 28, y: topHeight + 24, width: Math.max(100, canvas.width - 56), height: Math.max(100, canvas.height - topHeight - handHeight - 88) },
    });
    const pan = state.pan || { x: 0, y: 0 };
    if (pan.x || pan.y) {
      cam.p[0] += pan.x; cam.p[1] += pan.y;
      cam.t[0] += pan.x; cam.t[1] += pan.y;
      cam.update();
    }
    return cam;
  }
  function currentMap() {
    const id = (state.view && state.view.mapId) || (state.localBattle && state.localBattle.mapId) || "cross";
    const maps = (window.AKF_SIM && window.AKF_SIM.MAPS) || {};
    return maps[id] || maps.cross;
  }
  function heightAt(x, y) { return currentMap().isHigh(x, y) ? 1 : 0; }
  function isHigh(x, y) { return currentMap().isHigh(x, y); }
  function isPath(x, y) { return currentMap().isPath(x, y); }
  function isWall(x, y) { return currentMap().isWall(x, y); }
  function isOwnHalf(x) { return currentMap().inHalf(state.team, x); }

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
  }
  const tileAt = (p) => PROJ.pickTile(battleCam(), p.x, p.y, heightAt, MAP_H, MAP_W);
  // 路线绘制：候选取两层高度，优先与上一格相邻的候选（多高度层不误吸附）
  function routeTileAt(p, prev) {
    const cam = battleCam();
    const cands = [];
    for (const z of [0, 1]) {
      const q = cam.unproject(p.x, p.y, z);
      if (!q) continue;
      const col = Math.floor(q.x + 0.5), row = Math.floor(q.y + 0.5);
      if (col < 0 || col >= MAP_W || row < 0 || row >= MAP_H) continue;
      if (!cands.some((c) => c.x === col && c.y === row)) cands.push({ x: col, y: row });
    }
    if (!cands.length) return null;
    if (prev) {
      const adj = cands.find((c) => Math.abs(c.x - prev.x) + Math.abs(c.y - prev.y) === 1);
      if (adj) return adj;
      return null;   // 与路线不相邻的候选一律忽略
    }
    return cands.find((c) => heightAt(c.x, c.y) === 0) || cands[0];
  }

  function nearestUnit(p) {
    let best = null, bd = Infinity;
    const cam = battleCam();
    for (const u of (state.view ? state.view.units : [])) {
      const c = cam.project(u.x, u.y, heightAt(Math.round(u.x), Math.round(u.y)));
      const actor = spineLayer.actors.get(u.id);
      if (actor?.spine && !actor.spine.visible) continue;
      const width = Math.max(24, c.s * .7), height = Math.max(38, c.s * 1.35);
      const bounds = actor?.spine ? actor.spine.getBounds() : null;
      const left = bounds ? Math.max(bounds.x, c.x - width / 2) : c.x - width / 2;
      const right = bounds ? Math.min(bounds.x + bounds.width, c.x + width / 2) : c.x + width / 2;
      const top = bounds ? Math.max(bounds.y, c.y - height) : c.y - height;
      if (p.x < left - 7 || p.x > right + 7 || p.y < top - 7 || p.y > c.y + 12) continue;
      if (c.depth < bd) { best = u; bd = c.depth; }
    }
    return best;
  }

  canvas.addEventListener("click", (e) => {
    state.clickCount = (state.clickCount || 0) + 1;   // 诊断计数（只读）
    if (state.screen !== "battle" || !state.view) return;
    if (ROUTE.suppressClick) { ROUTE.suppressClick = false; state.lastClick = "suppressed"; return; }   // 拖拽建立跟随后不触发点选/部署
    const p = canvasPoint(e);
    // 场上 READY 菱形按钮与 E 同一单位、同一技能
    if (!state.highTarget && !state.descendTarget && state.skillButton && Math.abs(p.x - state.skillButton.x) + Math.abs(p.y - state.skillButton.y) <= state.skillButton.r / Math.SQRT2 + 5) {
      activateSelectedSkill();
      return;
    }
    const clicked = nearestUnit(p);
    if (!state.highTarget && !state.descendTarget && clicked) { selectBattleUnit(clicked); return; }
    const tile = tileAt(p);
    if (!tile) return;
    state.lastClick = `tile ${tile.x},${tile.y} ht=${state.highTarget}`;
    if (state.highTarget) {
      const mover = state.view && state.view.units.find((u) => u.id === state.highTarget);
      if (mover && Math.round(mover.x) === tile.x && Math.round(mover.y) === tile.y) {
        log("原地搬运：位置未变化（不消耗冷却）", "bad");   // 明确无操作反馈（不静默）
        return;
      }
      moveHighUnit(state.highTarget, tile); state.highTarget = null; return;
    }
    if (state.descendTarget) {
      // 下台点由服务器校验（相邻/地面/占位/路线）；下台后沿所选/原线路继续（F 不只发落点）
      const unitId = state.descendTarget;
      state.descendTarget = null;
      const du = state.view.units.find((u) => u.id === unitId);
      const dIntent = { kind: "descend", unitId, x: tile.x, y: tile.y };
      const dLine = du && du.lineId;
      if (dLine) { dIntent.line = dLine; if (ROUTE.waypoints.length) dIntent.waypoints = ROUTE.waypoints.slice(); }
      if (state.localSim && state.localBattle) {
        const dr = state.localSim.applyIntent(state.localBattle, state.team, dIntent);
        if (!dr.ok) log(`下地被拒绝：${dr.reason}`, "bad");
      }
      if (!state.localBattle) sendIntent(dIntent);
      return;
    }

    if ((e.shiftKey || ROUTE.advanced) && ROUTE.draftUnitId && state.routeDraft.length) { ROUTE.applyCell(tile, "click"); return; }
    const op = operator(state.selectedOpId);
    if (!op) return;
    const handEntry = state.view.hand[state.team].find((h) => h.opId === op.id);
    if (!handEntry) { log("小队中没有该干员。", "bad"); return; }
    if (handEntry.readyIn > 0) { log(`${op.name} 再部署冷却中（${handEntry.readyIn}s）`, "bad"); return; }
    if (state.view.cost[state.team] < op.cost) { log("部署费用不足。", "bad"); return; }
    if (!isOwnHalf(tile.x) || !inInitialZone(tile.x, tile.y)) { log("只能在己方初始部署区内部署。", "bad"); return; }
    // 双部署（与服务器同一判定）：原高台干员可上台，也可直接落己方合法地面格（下地部署，无台上加成）
    const mapNow = currentMap();
    const okTerrain = op.high
      ? (mapNow.highDeploy(tile.x, tile.y) || mapNow.groundDeploy(tile.x, tile.y))
      : mapNow.groundDeploy(tile.x, tile.y);
    if (!okTerrain) {
      log(op.high ? "该格不是可部署地块。" : "地面干员不能部署在高台。", "bad");
      return;
    }
    deployAt(op.id, tile);
  });

  canvas.addEventListener("mousedown", (e) => {
    if (state.screen !== "battle" || !state.view || e.button !== 0) return;
    const p = canvasPoint(e);
    const hit0 = nearestUnit(p);
    // F4 手势仲裁（互斥，同手势只发一种意图）：未确认选向（主操作） > 显式高台搬运（R/按钮） > 跟随拖拽
    // 高台干员直接拖动搬运优先（无需R键）
    if (hit0 && HIGHDRAG.begin(hit0, e)) return;
    // 选向拖动次优先
    if (hit0 && !state.highTarget && FACING.beginAimDrag(hit0, e)) return;
    ROUTE.onDown(e);
  });

  canvas.addEventListener("mousemove", (e) => {
    state.moveCount = (state.moveCount || 0) + 1;
    if (FACING.drag || HIGHDRAG.active) return;   // 手势中：由 window 监听接管（指针滑过 HUD 也不掉链）
    // 线路制：鼠标移动只做悬停/拖拽跟随判定，不再逐格重画整条路线（预览按线路一次成形）
    ROUTE.onMove(e);
  });

  // 手势拖动（选向/显式搬运）统一走 window：拖过技能按钮等 pointer-events 区不断链、不误发第二意图
  window.addEventListener("mousemove", (e) => {
    if (!FACING.drag && !HIGHDRAG.active) return;
    if (FACING.onAimMove(e)) return;
    HIGHDRAG.onMove(e);
  });

  window.addEventListener("mouseup", (e) => {
    if (state.screen !== "battle") return;
    if (FACING.onAimUp()) { ROUTE.suppressClick = true; return; }   // 松手=一次确认（小幅点击交还点选）
    HIGHDRAG.onUp(e);
    ROUTE.onUp(e);
  });

  // ---------------- 战斗：简化选路（线路制）+ 跟随（线路条/预览/拖拽跟随叠层） ----------------
  // 预览叠层独立于地形/单位/特效层：线路走廊、途经点、跟随连线与拖拽目标高亮都画在这里。
  const routeCanvas = $("routeCanvas");
  const routeCtx = routeCanvas ? routeCanvas.getContext("2d") : null;
  if (routeCanvas) {
    routeCanvas.style.position = "absolute";
    routeCanvas.style.inset = "0";
    routeCanvas.style.pointerEvents = "none";
  }
  const ROUTE = {
    mapId: null,
    lineId: null,          // 当前线路（一批部署沿用；线路条可切换）
    userPinned: false,     // 是否手动钉住线路（钉住后一批部署沿用）
    advanced: false,       // 高级模式（H 开/关）：鼠标划格累积完整自定义线路（规则终稿见 线路规范）
    waypoints: [],         // 自定义线路格（起点之后）：march 意图原样下发（>64 只发合法前缀）
    customPath: [],        // 高级模式路径草稿（含起点格）；仅[起点]=按默认线路推进
    draftStart: null,
    draftUnitId: null,
    drag: null,            // 跟随拖拽：{from, unit, target, active}
    suppressClick: false,
    lines() { return (currentMap() && currentMap().lines) || []; },
    lineById(id) { return this.lines().find((l) => l.id === id) || null; },
    lineName() { const l = this.lineById(this.lineId); return l ? l.name : "默认线路"; },
    pathOf(line) { return state.team === "blue" ? line.blue : line.red; },
    syncMap() {
      const m = currentMap();
      if (this.mapId !== m.id) {
        this.mapId = m.id;
        this.userPinned = false;
        this.lineId = (m.lines && m.lines[0] && m.lines[0].id) || null;
        this.waypoints = [];
        this.customPath = [];
        this.advanced = false;
        this.draftStart = null;
        this.renderBar();
        this.renderModeBtn();
      }
    },
    // 部署点所在线路（默认选路）：离部署格最近的走廊所属线路
    pickLine(tile) {
      const best = SIM.nearestLine(currentMap(), state.team, tile);
      return best ? best.id : null;
    },
    // 预览/意图同源组路：沿线路推进（部署点与走廊只做合法连接；自定义格仅高级模式逐格累积）
    build(start) {
      const m = currentMap();
      if (!this.lineId) return null;
      if (m.highDeploy(start.x, start.y)) return { ok: true, route: [{ x: start.x, y: start.y }], lineId: this.lineId };
      return SIM.buildLineRoute(m, this.lineId, state.team, { x: start.x, y: start.y }, this.waypoints.length ? this.waypoints.slice() : null);
    },
    // 草稿=预览/意图同源：waypoints 取自 customPath（起点之后全部格），预览即服务器组路结果
    syncDraft() {
      if (!this.draftStart) { state.routeDraft = []; this.renderBar(); return; }
      this.waypoints = this.customPath.slice(1).map((t) => ({ x: t.x, y: t.y }));
      const built = this.build(this.draftStart);
      state.routeDraft = built && built.ok ? built.route.slice() : this.customPath.slice();
      this.renderBar();
    },
    beginMarch(unit) {
      this.syncMap();
      if (!unit.marchAllowed) return;
      const start = { x: Math.round(unit.x), y: Math.round(unit.y) };
      if (!this.userPinned) this.lineId = this.pickLine(start) || this.lineId;
      this.draftUnitId = unit.id;
      this.draftStart = start;
      this.customPath = [start];
      this.syncDraft();
      const hint = $("routeHint");
      if (hint) hint.textContent = `${operator(unit.opId).name} 已驻守 · ↑/↓ 切换线路 · Enter 出发 · 空格 自动寻路 · H 高级模式`;
    },
    // —— 高级模式（交互规则终稿）：hover 格序列累积成完整自定义线路 ——
    // 1) 鼠标划过的格子逐格累积（跳跃自动按楼梯补中间格，逐格 4-邻接校验）；
    // 2) 鼠标再次经过已选格 = 截断到该格（取消其后线段；回退擦除，路径恒为简单链=永不打结）；
    // 3) 只走可走格；不允许回退：沿进攻轴不倒退（蓝 x 只增不减 / 红 x 只减不增），违规格忽略并提示；
    // 4) 末格必须=敌方门格才可确认（confirmRoute 校验）；
    // 5) 确认后 march 意图带完整 waypoints（相邻逐格=BFS 原样）；>64 格只发合法前缀（服务器上限），其余由所选线路补完。
    enemyGateAt(cell) {
      const m = currentMap();
      const enemy = state.team === "blue" ? "red" : "blue";
      return ((m.gates && m.gates[enemy]) || []).some((g) => g.x === cell.x && g.y === cell.y);
    },
    // 该方全部可选敌方终点门（高级模式玩家自选；预览/高亮/裁决同源）
    enemyGates() {
      if (typeof SIM.enemyGates !== "function") return [];
      return SIM.enemyGates(currentMap(), state.team);
    },
    // 当前自定义草稿实际抵达的门（末格=敌门时）；未抵达返回 null
    draftGate() {
      const tip = this.customPath[this.customPath.length - 1];
      if (!tip || !this.enemyGateAt(tip)) return null;
      return { x: tip.x, y: tip.y };
    },
    customAtGate() {
      const tip = this.customPath[this.customPath.length - 1];
      return !tip || this.enemyGateAt(tip);
    },
    // 单格处理（hover/点击/Shift+点击同源）：命中已选格=截断擦除；邻接新格=校验后追加
    applyCell(cell, via) {
      if (!this.draftStart || !this.customPath.length) return false;
      const path = this.customPath;
      const idx = path.findIndex((t) => t.x === cell.x && t.y === cell.y);
      if (idx >= 0) {
        if (idx === path.length - 1) return false;                 // 已在线尾：不变
        this.customPath = path.slice(0, idx + 1);                  // 再次经过已选线段=取消该段（截断到该格）
        this.syncDraft();
        if (via !== "hover") log(`已取消（${cell.x}, ${cell.y}）之后的线段`, "sys");
        return true;
      }
      const tip = path[path.length - 1];
      if (Math.abs(cell.x - tip.x) + Math.abs(cell.y - tip.y) !== 1) return false;   // 只接 4 邻格
      if (!currentMap().routable(cell.x, cell.y)) {
        if (via !== "hover") log("该格不可通行，未加入线路", "bad");
        return false;
      }
      if (!(state.team === "blue" ? cell.x >= tip.x : cell.x <= tip.x)) {
        // 前进性校验：不允许回退（沿进攻轴不倒退=不能朝己方门方向走）；违规格忽略并提示（hover 限频）
        const now = performance.now();
        if (via !== "hover" || now - (this._backWarnAt || 0) > 600) {
          this._backWarnAt = now;
          log("线路不允许回退：只能前进/横移，不能朝己方门方向走", "bad");
        }
        return false;
      }
      if (path.length >= 220) return false;
      this.customPath = path.concat([{ x: cell.x, y: cell.y }]);
      this.syncDraft();
      return true;
    },
    // hover 累积：目标格非邻接时按 x 优先楼梯补中间格（逐格走 applyCell；触到已选格=截断擦除）
    // 手感要点：①鼠标往**已画线段**回划=立即擦除该格之后的所有线段（不必精确回到线尾）；
    // ②目标格回退到己方门方向且不在线上=按「回删」擦掉线尾若干格（连续回划连续变短），
    // 与「非法前进」区分：回划是编辑手势，不刷错误提示。
    hoverPath(p) {
      const target = routeTileAt(p, null);
      if (!target || !this.customPath.length) return;
      const path = this.customPath;
      // ① 目标落在已选线段内（非线尾）→ 截断擦除到该格
      const hit = path.findIndex((t, i) => i < path.length - 1 && t.x === target.x && t.y === target.y);
      if (hit >= 0) {
        if (this._eraseWarnAt !== undefined) this._eraseWarnAt = 0;
        this.customPath = path.slice(0, hit + 1);
        this.syncDraft();
        return;
      }
      // ② 回划擦除：目标格**就在已画过的线段上**（同 x 且 y 落在该列已覆盖范围 / 同 y 且 x 落在该行已覆盖范围）
      // 才算「鼠标划回去=取消该段」。仅凭「x 比线尾小」会把正常的绕行（不可走格绕路）误判成回划，
      // 从而把刚画的线删掉 —— 必须要求目标格真实落在已有轨迹上。
      const tip = path[path.length - 1];
      const adjacent = Math.abs(target.x - tip.x) + Math.abs(target.y - tip.y) === 1;
      const onTrail = !adjacent && path.some((t) => t.x === target.x && t.y === target.y);
      if (onTrail) {
        const hit = path.findIndex((t) => t.x === target.x && t.y === target.y);
        if (hit >= 0 && hit < path.length - 1) {
          this.customPath = path.slice(0, hit + 1);
          this.syncDraft();
          return;
        }
      }
      for (let guard = 0; guard < 256; guard += 1) {
        const t = this.customPath[this.customPath.length - 1];
        if (t.x === target.x && t.y === target.y) return;
        const dx = target.x - t.x, dy = target.y - t.y;
        // 优先沿进攻轴（x）靠近目标；被不可走格挡住时改走 y 绕开（不阻断累积，避免卡在障碍前）
        const tryOrder = Math.abs(dx) >= Math.abs(dy)
          ? [{ x: t.x + Math.sign(dx), y: t.y }, { x: t.x, y: t.y + Math.sign(dy) }]
          : [{ x: t.x, y: t.y + Math.sign(dy) }, { x: t.x + Math.sign(dx), y: t.y }];
        let moved = false;
        for (const step of tryOrder) {
          if (step.x === t.x && step.y === t.y) continue;
          if (this.applyCell(step, "hover")) { moved = true; break; }
        }
        if (!moved) return;   // 两个方向都走不通（真死路）才停手
      }
    },
    toggleAdvanced(force) {
      const on = force === undefined ? !this.advanced : !!force;
      if (on === this.advanced) return;
      this.advanced = on;
      if (this.draftStart) this.customPath = [{ x: this.draftStart.x, y: this.draftStart.y }];
      this.syncDraft();
      this.renderModeBtn();
      log(on
        ? "高级模式开：鼠标划过格子累积自定义线路（再经过已选线段=取消该段；只能前进/横移；终点必须=敌方门格）"
        : "高级模式关：回到纯线路推进（↑/↓ 切换线路）", "sys");
    },
    clearPreview() {
      // Esc 第一层：只清自定义线段（保留高级模式）
      if (!this.draftStart) return;
      this.customPath = [{ x: this.draftStart.x, y: this.draftStart.y }];
      this.syncDraft();
    },
    clearAll() {
      // G=取消全部已选线：清空自定义路径并退出高级模式，回到默认线路预览
      const had = this.customPath.length > 1 || this.advanced;
      this.advanced = false;
      if (this.draftStart) this.customPath = [{ x: this.draftStart.x, y: this.draftStart.y }];
      else this.customPath = [];
      this.syncDraft();
      this.renderModeBtn();
      log(had ? "已取消全部已选线（回到默认线路）" : "当前没有已选线段", "sys");
    },
    cycleLine(delta) {
      const lines = this.lines();
      if (!lines.length) return;
      const i = Math.max(0, lines.findIndex((l) => l.id === this.lineId));
      this.userPinned = true;
      this.lineId = lines[(i + delta + lines.length) % lines.length].id;
      if (this.customPath.length <= 1) this.syncDraft();   // 高级自定义路径与线路无关，保留
      else this.renderBar();
      log(`当前线路：${this.lineName()}（${lines.findIndex((l) => l.id === this.lineId) + 1}/${lines.length}）`, "sys");
    },
    autoRoute() {
      // 空格=默认自动寻路：按当前站位/部署点最近线路自动成路并预览（Enter 确认出发）
      if (!this.draftStart) { log("先点选落地的己方干员（或部署）再按空格自动寻路", "bad"); return; }
      this.userPinned = false;
      this.advanced = false;
      this.customPath = [{ x: this.draftStart.x, y: this.draftStart.y }];
      const near = this.pickLine(this.draftStart);
      if (near) this.lineId = near;
      this.syncDraft();
      this.renderModeBtn();
      log(`自动寻路：${this.lineName()}（部署点/站位所在线路）已成路预览 · Enter 出发`, "sys");
    },
    clearDraft() {
      this.draftStart = null;
      this.draftUnitId = null;
      this.waypoints = [];
      this.customPath = [];
      this.drag = null;
      state.routeDraft = [];
      this.showTip(null);
      if ($("routeHint")) $("routeHint").textContent = "↑/↓ 切换线路 · Enter 出发 · 空格 自动寻路 · H 高级模式 · G 清空路线";
      // 立即清空路线canvas，避免残留
      if (routeCtx && routeCanvas) {
        routeCtx.clearRect(0, 0, routeCanvas.width, routeCanvas.height);
      }
    },
    // 跟随拖放目标：比点选更大的拾取半径（拖放移动中的队友更宽容；高亮+名称先于松手确认）
    dropTarget(p) {
      const hit = nearestUnit(p);
      return hit && hit.team === state.team ? hit : null;
    },
    // —— 跟随拖拽（拖动阈值 >8px 判拖动；<8px 判点选）——
    onDown(e) {
      this.suppressClick = false;                 // 新手势起点：清掉上次拖拽的点选抑制（防漏吞下一次点击）
      const p = canvasPoint(e);
      const u = nearestUnit(p);
      this.drag = { from: p, unit: u && u.team === state.team && u.positionMode === "ground" ? u : null, target: null, active: false };
    },
    onMove(e) {
      if (state.screen !== "battle" || !state.view) return;
      const p = canvasPoint(e);
      if (this.drag && this.drag.unit && e.buttons !== 0) {
        const d = Math.hypot(p.x - this.drag.from.x, p.y - this.drag.from.y);
        if (d > 8) this.drag.active = true;
        if (this.drag.active) {
          const t = this.dropTarget(p);
          const target = t && t.id !== this.drag.unit.id ? t : null;
          this.drag.target = target;
          this.showTip(target, p);
        }
        return;   // 跟随拖拽手势期间不画线（手势互斥）
      }
      // 高级模式：hover 格序列累积成完整自定义线路（再经过已选线段=取消该段）
      if (this.advanced && this.draftUnitId && this.customPath.length) this.hoverPath(p);
    },
    onUp(e) {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      this.showTip(null);
      if (d && d.active && d.unit) {
        this.suppressClick = true;                       // 拖拽手势不落成点选/部署
        if (d.target) {
          sendFollow(d.unit.id, d.target.id);
          log(`${operator(d.unit.opId).name} → 跟随 ${operator(d.target.opId).name}（拖拽建立）`, "sys");
        } else {
          log("拖到己方干员身上松手可建立跟随（拖到空白处取消）。", "sys");
        }
      }
    },
    showTip(target, p) {
      const tip = $("followTip");
      if (!tip) return;
      if (!target || !p) { tip.classList.add("hidden"); return; }
      const op = operator(target.opId);
      const r = canvas.getBoundingClientRect();
      const screen = document.querySelector(".boardStack");
      const sr = screen ? screen.getBoundingClientRect() : r;
      tip.textContent = `跟随目标：${op ? op.name : target.id}`;
      tip.style.left = `${p.x * r.width / canvas.width + (r.left - sr.left)}px`;
      tip.style.top = `${p.y * r.height / canvas.height + (r.top - sr.top)}px`;
      tip.classList.remove("hidden");
    },
    // 线路条（不再放上路/下路按钮）：只显示当前线路名+候选序号+模式；切换=↑/↓ 循环，出发=Enter
    renderBar() {
      const bar = $("routeLines");
      if (!bar) return;
      const lines = this.lines();
      const i = Math.max(0, lines.findIndex((l) => l.id === this.lineId));
      // 高级模式线路条：格数 + 终点门状态（玩家自选的门必须一眼可见）
      let seg = "";
      if (this.advanced) {
        const n = Math.max(0, this.customPath.length - 1);
        const dg = this.draftGate();
        const gates = this.enemyGates();
        const gi = dg ? gates.findIndex((x) => x.x === dg.x && x.y === dg.y) : -1;
        seg = n
          ? ` · 自定义 ${n} 格${dg ? ` → 敌门${gates.length > 1 ? ` ${gi + 1}/${gates.length}` : ""} ✓` : " · 未到敌门"}`
          : " · 划过格子累积线路";
      } else if (this.customPath.length > 1) {
        seg = ` · 自定义 ${this.customPath.length - 1} 格`;
      }
      bar.innerHTML = `<span class="rbLabel">当前线路：${this.lineName()}${lines.length ? `（${i + 1}/${lines.length}）` : ""} · `
        + `${this.advanced ? "高级模式" : (this.userPinned ? "手动选线" : "自动 · 部署点所在线路")}${seg}</span>`;
    },
    renderModeBtn() {
      const b = $("routeModeBtn");
      if (!b) return;
      b.textContent = `高级模式 H：${this.advanced ? "开" : "关"}`;
      b.classList.toggle("active", this.advanced);
    },
    renderFollowBadge() {
      const badge = $("followBadge"), clearBtn = $("followClearBtn");
      if (!badge || !clearBtn) return;
      const u = selectedUnit();
      const leader = u && u.followOf && state.view ? state.view.units.find((x) => x.id === u.followOf) : null;
      if (leader) {
        const lop = operator(leader.opId);
        badge.textContent = `跟随中：${lop ? lop.name : leader.id}`;
        clearBtn.classList.remove("hidden");
      } else if (u) {
        badge.textContent = "";
        clearBtn.classList.add("hidden");
      } else {
        badge.textContent = "";
        clearBtn.classList.add("hidden");
      }
    },
    // 预览叠层：当前线路走廊 + 目标门 + 途经点 + 跟随连线 + 拖拽目标高亮
    drawOverlay() {
      if (!routeCtx) return;
      const w = canvas.width, h = canvas.height;
      if (routeCanvas.width !== w || routeCanvas.height !== h) { routeCanvas.width = w; routeCanvas.height = h; }
      routeCtx.clearRect(0, 0, w, h);
      if (state.screen !== "battle") return;
      const cam = battleCam();
      const g = routeCtx;
      
      // 绘制自定义路径（从选中干员出发的草稿路线）
      if (state.routeDraft && state.routeDraft.length > 1) {
        const pts = state.routeDraft.map((t) => cam.project(t.x, t.y, heightAt(t.x, t.y)));
        if (pts.length > 1) {
          const trace = () => {
            g.beginPath();
            pts.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
          };
          g.save();
          g.lineJoin = "round";
          g.lineCap = "round";
          // 金色高亮路线（从选中干员出发）
          trace(); g.lineWidth = 12; g.strokeStyle = "rgba(255,196,60,.15)"; g.stroke();
          trace(); g.lineWidth = 6; g.strokeStyle = "rgba(255,216,0,.45)"; g.stroke();
          trace(); g.lineWidth = 2.5; g.strokeStyle = "rgba(255,240,190,.85)"; g.stroke();
          // 流动刻度
          const ph = (performance.now() / 300) % 1;
          g.lineWidth = 2;
          g.strokeStyle = "rgba(255,250,225,.7)";
          for (let d = ph; d < 1; d += 0.11) {
            const seg = d * (pts.length - 1);
            const i = Math.floor(seg), f = seg - i;
            if (i >= pts.length - 1) break;
            const a = pts[i], b = pts[i + 1];
            const mx = a.x + (b.x - a.x) * f, my = a.y + (b.y - a.y) * f;
            const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
            const r = 4;
            g.beginPath();
            g.moveTo(mx - Math.cos(ang) * r, my - Math.sin(ang) * r);
            g.lineTo(mx + Math.cos(ang) * r, my + Math.sin(ang) * r);
            g.stroke();
          }
          g.restore();
        }
      } else {
        // 默认线路预览（无草稿时显示）
        const line = this.lineById(this.lineId);
        if (line) {
          const path = this.pathOf(line);
          const pts = path.map((t) => cam.project(t.x, t.y, heightAt(t.x, t.y)));
          if (pts.length > 1) {
            const trace = () => {
              g.beginPath();
              pts.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
            };
            g.save();
            g.lineJoin = "round";
            g.lineCap = "round";
            // 青蓝默认线路
            trace(); g.lineWidth = 10; g.strokeStyle = "rgba(84,184,255,.10)"; g.stroke();
            trace(); g.lineWidth = 5; g.strokeStyle = "rgba(96,190,255,.36)"; g.stroke();
            trace(); g.lineWidth = 1.6; g.strokeStyle = "rgba(200,236,255,.75)"; g.stroke();
            g.restore();
          }
        }
      }
      
      const line = this.lineById(this.lineId);
      if (line) {
        // 线路终点门
        const gate = line.gate && line.gate[state.team === "blue" ? "blue" : "red"];
        if (gate) {
          const c = cam.project(gate.x, gate.y + 0.5, 0);
          const gp = 0.5 + 0.5 * Math.sin(performance.now() / 400);
          const R = 24 + 4 * gp;
          g.save();
          const gl = g.createRadialGradient(c.x, c.y, R * 0.2, c.x, c.y, R);
          gl.addColorStop(0, `rgba(120,200,255,${0.26 + 0.10 * gp})`);
          gl.addColorStop(1, "rgba(60,150,255,0)");
          g.fillStyle = gl;
          g.beginPath(); g.ellipse(c.x, c.y, R, R * 0.5, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = "rgba(190,228,255,.85)";
          g.lineWidth = 2;
          g.beginPath(); g.ellipse(c.x, c.y, R * 0.7, R * 0.35, 0, 0, Math.PI * 2); g.stroke();
          // 顶部宝石
          const gy = c.y - 30, gs = 8;
          g.strokeStyle = "rgba(200,236,255,.9)";
          g.lineWidth = 2;
          g.beginPath(); g.moveTo(c.x, c.y - 8); g.lineTo(c.x, c.y); g.stroke();
          g.beginPath();
          g.moveTo(c.x, gy - gs); g.lineTo(c.x + gs * 0.72, gy); g.lineTo(c.x, gy + gs); g.lineTo(c.x - gs * 0.72, gy);
          g.closePath();
          const gl3 = g.createLinearGradient(c.x, gy - gs, c.x, gy + gs);
          gl3.addColorStop(0, "rgba(235,250,255,.98)");
          gl3.addColorStop(0.5, "rgba(150,215,255,.95)");
          gl3.addColorStop(1, "rgba(70,150,230,.95)");
          g.fillStyle = gl3;
          g.fill();
          g.strokeStyle = "rgba(255,255,255,.95)";
          g.lineWidth = 1.4;
          g.stroke();
          g.restore();
        }
      }
      // 高级模式：画出该方**全部可选敌方终点门**（玩家自选；已抵达的门实心高亮，其余虚线环提示可选）
      if (this.advanced && this.draftStart) {
        const reached = this.draftGate();
        const gp = 0.5 + 0.5 * Math.sin(performance.now() / 380);
        for (const gt of this.enemyGates()) {
          const c = cam.project(gt.x, gt.y, heightAt(gt.x, gt.y));
          const on = reached && reached.x === gt.x && reached.y === gt.y;
          g.save();
          if (on) {
            // 抵达门：地面脉冲光环 + 门柱高亮 + 顶部菱形宝石（与场上技能宝石同一造型语言）
            const R = 30 + 5 * gp;
            const gl = g.createRadialGradient(c.x, c.y, R * 0.25, c.x, c.y, R);
            gl.addColorStop(0, "rgba(255,206,90,.34)");
            gl.addColorStop(0.7, "rgba(255,180,40,.14)");
            gl.addColorStop(1, "rgba(255,160,0,0)");
            g.fillStyle = gl;
            g.beginPath(); g.ellipse(c.x, c.y, R, R * 0.5, 0, 0, Math.PI * 2); g.fill();
            g.strokeStyle = "rgba(255,226,150,.9)";
            g.lineWidth = 2.4;
            g.setLineDash([]);
            g.beginPath(); g.ellipse(c.x, c.y, R * 0.72, R * 0.36, 0, 0, Math.PI * 2); g.stroke();
            // 门柱两侧光柱
            g.globalAlpha = 0.55 + 0.25 * gp;
            g.strokeStyle = "rgba(255,214,110,.95)";
            g.lineWidth = 3;
            g.beginPath(); g.moveTo(c.x, c.y - 46); g.lineTo(c.x, c.y - 6); g.stroke();
            g.globalAlpha = 1;
            // 顶部菱形宝石
            const gemY = c.y - 56, gs = 9;
            const gl2 = g.createRadialGradient(c.x, gemY, 0, c.x, gemY, gs * 2.6);
            gl2.addColorStop(0, `rgba(255,220,120,${0.4 + 0.2 * gp})`);
            gl2.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = gl2;
            g.beginPath(); g.arc(c.x, gemY, gs * 2.6, 0, Math.PI * 2); g.fill();
            g.translate(c.x, gemY);
            g.beginPath();
            g.moveTo(0, -gs); g.lineTo(gs * 0.72, 0); g.lineTo(0, gs); g.lineTo(-gs * 0.72, 0);
            g.closePath();
            g.fillStyle = "rgba(255,226,150,.98)";
            g.fill();
            g.strokeStyle = "rgba(255,255,235,.95)";
            g.lineWidth = 1.6;
            g.stroke();
          } else {
            // 未选中的可选门：细虚线环 + 中心小点（可点但不抢视线）
            g.strokeStyle = "rgba(255,206,90,.5)";
            g.lineWidth = 2;
            g.setLineDash([6, 6]);
            g.beginPath(); g.ellipse(c.x, c.y, 22, 11, 0, 0, Math.PI * 2); g.stroke();
            g.setLineDash([]);
            g.fillStyle = "rgba(255,206,90,.5)";
            g.beginPath(); g.arc(c.x, c.y, 3.4, 0, Math.PI * 2); g.fill();
          }
          g.restore();
        }
      }
      // 途经点刻度：替代原先每个节点一个白色方块（用户反馈丑/像调试标记）。
      // 改为「发光小菱形 + 极淡连接点」，与路线光带同一金色语言，不喧宾夺主。
      if (this.waypoints.length) {
        const wpPhase = 0.5 + 0.5 * Math.sin(performance.now() / 300);
        for (let i = 0; i < this.waypoints.length; i += 1) {
          const wp = this.waypoints[i];
          const c = cam.project(wp.x, wp.y, heightAt(wp.x, wp.y));
          const isLast = i === this.waypoints.length - 1;
          const s = isLast ? 6.5 : 4.2;
          g.save();
          g.translate(c.x, c.y);
          if (isLast) {
            const gl = g.createRadialGradient(0, 0, 0, 0, 0, s * 3.2);
            gl.addColorStop(0, `rgba(255,214,110,${0.30 + 0.18 * wpPhase})`);
            gl.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = gl;
            g.beginPath(); g.arc(0, 0, s * 3.2, 0, Math.PI * 2); g.fill();
          }
          g.rotate(Math.PI / 4);
          g.fillStyle = isLast ? "rgba(255,226,150,.98)" : "rgba(255,226,150,.62)";
          g.fillRect(-s, -s, s * 2, s * 2);
          g.strokeStyle = "rgba(120,80,10,.55)";
          g.lineWidth = 1.2;
          g.strokeRect(-s, -s, s * 2, s * 2);
          g.restore();
        }
      }
      const view = state.view;
      if (view) {
        for (const u of view.units) {
          if (u.team !== state.team || !u.followOf) continue;
          const t = view.units.find((x) => x.id === u.followOf);
          if (!t) continue;
          const a = cam.project(u.x, u.y, heightAt(Math.round(u.x), Math.round(u.y)));
          const b2 = cam.project(t.x, t.y, heightAt(Math.round(t.x), Math.round(t.y)));
          g.strokeStyle = "rgba(84,184,255,.8)";
          g.lineWidth = 2;
          g.setLineDash([6, 6]);
          g.beginPath(); g.moveTo(a.x, a.y - 12); g.lineTo(b2.x, b2.y - 12); g.stroke();
          g.setLineDash([]);
        }
      }
      if (this.drag && this.drag.active && this.drag.target) {
        const t = this.drag.target;
        const c = cam.project(t.x, t.y, heightAt(Math.round(t.x), Math.round(t.y)));
        g.strokeStyle = "#54b8ff"; g.lineWidth = 4;
        g.beginPath(); g.arc(c.x, c.y - 12, 28, 0, Math.PI * 2); g.stroke();
      }
    },
  };
  (function routeLoop() {
    try {
      ROUTE.syncMap();
      if (state.screen === "battle") {
        ROUTE.drawOverlay();
        ROUTE.renderFollowBadge();
      }
    } catch (routeErr) {
      if (!routeLoop._err || routeLoop._err !== String(routeErr)) {
        routeLoop._err = String(routeErr);
        log(`线路叠层错误：${routeErr && routeErr.message ? routeErr.message : routeErr}`, "bad");
      }
    }
    requestAnimationFrame(routeLoop);
  })();
  (function bindRouteBar() {
    const modeBtn = $("routeModeBtn");
    if (modeBtn) {
      modeBtn.addEventListener("click", () => ROUTE.toggleAdvanced());   // 与 H 同一入口（单实现）
    }
    const clearBtn = $("followClearBtn");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const u = selectedUnit();
        if (!u || !u.followOf) return;
        sendFollow(u.id, null);
        log(`${operator(u.opId).name} 解除跟随`, "sys");
      });
    }
  })();

  // ---------------- 战斗：四向朝向（选向 UI / 脚下方向箭头 / 四向范围变换） ----------------
  // 契约（与 sim.js 严格一致）：快照 units[] 含 facing:{x,y}（右(1,0)/左(-1,0)/下(0,1)/上(0,-1)）与 facingConfirmed；
  // 意图 {kind:"facing", unitId, dir:"up"|"down"|"left"|"right"}（up=(0,-1) down=(0,1) left=(-1,0) right=(1,0)）。
  // 四向世界范围变换（攻击范围/技能范围/斜纹小图/脚下箭头全部同源）：
  // gx = unit.x + col·dx − row·dy；gy = unit.y + col·dy + row·dx（不再按 team±x）。
  const FACING_DIRS = {
    right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, down: { x: 0, y: 1 }, up: { x: 0, y: -1 },
  };
  const FACING_KEY_DIRS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  const FACING_DEFAULT_DIR = { blue: "right", red: "left" };
  const FACING_NAME_CN = { up: "上", down: "下", left: "左", right: "右" };
  function facingVecByName(name) {
    return Object.hasOwn(FACING_DIRS, name) ? FACING_DIRS[name] : null;   // 仅认四个自有键（防 "toString" 等原型链注入）
  }
  // 前端先行镜像：sim/服务器尚未回传 facing 字段时本地权威显示（回传后一律以 unit.facing 为准）
  const facingLocal = new Map();   // unitId -> {x,y,dir,confirmed,pending}

  function facingDirName(vec) {
    if (!vec || (!vec.x && !vec.y)) return null;
    if (vec.x > 0) return "right";
    if (vec.x < 0) return "left";
    return vec.y > 0 ? "down" : "up";
  }
  function facingUnitVec(unit) {
    if (unit && unit.facing && (unit.facing.x || unit.facing.y)) return { x: unit.facing.x, y: unit.facing.y };
    const rec = unit && facingLocal.get(unit.id);
    if (rec) return { x: rec.x, y: rec.y };
    return facingVecByName((unit && FACING_DEFAULT_DIR[unit.team]) || "right");
  }
  function facingUnconfirmed(unit) {
    if (!unit || unit.team !== state.team) return false;
    if (unit.facing && unit.facingConfirmed !== undefined) return unit.facingConfirmed === false;   // 权威快照口径（含方向锁发放）
    if (unit.facingConfirmed === false) return true;
    const rec = facingLocal.get(unit.id);
    return !!(rec && rec.pending);
  }
  // 四向世界范围变换（契约同式）
  function facingCells(cx, cy, vec, offsets) {
    const out = [];
    for (const o of offsets) out.push({ x: cx + o.col * vec.x - o.row * vec.y, y: cy + o.col * vec.y + o.row * vec.x });
    return out;
  }
  // 选路草稿首段朝向（世界四向；未形成折线段时返回 null）
  function routeSegmentFacing(unit) {
    if (!unit || unit.id !== ROUTE.draftUnitId) return null;
    const r = state.routeDraft;
    if (!Array.isArray(r) || r.length < 2) return null;
    const dx = r[1].x - r[0].x, dy = r[1].y - r[0].y;
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? FACING_DIRS.right : FACING_DIRS.left;
    if (dy !== 0) return dy > 0 ? FACING_DIRS.down : FACING_DIRS.up;
    return null;
  }

  const FACING = {
    pick: null,          // { unitId, dir }：进行中的选向（未确认单位）
    seen: null,          // Map：已见单位（新上场高台单位 → 紧接进入选向）
    snoozeUntil: 0,
    snooze: null,        // { id, until }：Esc 暂时收起（按单位）
    dismissedFor: null,  // 当前选中内已被收起的单位（重选即清）
    lastSelId: null,
    confirmedSeen: new Map(),   // unitId -> 上次 facingConfirmed（方向锁发放检测）
    drag: null,          // { unitId, from, moved }：拖向选向主操作
    ackUntil: 0,
    intentCount: 0,
    shotDone: false,
    domSig: "",

    vectorFor(unit) {
      if (!unit) return FACING_DIRS.right;
      if (this.pick && this.pick.unitId === unit.id) return facingVecByName(this.pick.dir) || FACING_DIRS.right;
      // 路线草稿首段朝向（选路未出发=按首段预览；行军中由快照 facing 权威接管）
      const seg = routeSegmentFacing(unit);
      if (seg) return seg;
      return facingUnitVec(unit);
    },
    // 当前真实朝向（权威=快照 facing/本地镜像）；未来预览=选向候选或路线草稿首段（与当前不同才有值）
    currentVec(unit) { return facingUnitVec(unit); },
    futureVec(unit) {
      if (!unit) return null;
      const cand = (this.pick && this.pick.unitId === unit.id) ? (facingVecByName(this.pick.dir) || null) : null;
      const seg = cand || routeSegmentFacing(unit);
      if (!seg) return null;
      const cur = facingUnitVec(unit);
      if (cur && seg.x === cur.x && seg.y === cur.y) return null;
      return { x: seg.x, y: seg.y, kind: cand ? "候选" : "行军后" };
    },
    syncDom() {
      const el = $("facingPicker"), hint = $("facingHint");
      if (!el || !hint) return;
      const view = state.view;
      const pendingIds = view ? view.units.filter((u) => facingUnconfirmed(u)).map((u) => u.id) : [];
      const sig = `${state.screen}|${this.pick ? `${this.pick.unitId}:${this.pick.dir}` : ""}|${pendingIds.join(",")}|ht:${state.highTarget || ""}`;
      if (sig === this.domSig) return;
      this.domSig = sig;
      // 显式搬运模式期间隐藏选向面板（面板按钮不得盖住目标高台锚点吞点击；退出模式自动恢复）
      el.classList.toggle("hidden", !this.pick || !!state.highTarget);
      const anyPending = !!(this.pick || pendingIds.length);
      hint.classList.toggle("hidden", !anyPending || state.screen !== "battle");
      if (this.pick) {
        for (const b of el.querySelectorAll("[data-dir]")) b.classList.toggle("candidate", b.dataset.dir === this.pick.dir);
        const label = $("facingPickLabel");
        if (label) label.textContent = `朝向：${FACING_NAME_CN[this.pick.dir] || ""}`;
      }
      hint.textContent = this.pick
        ? "选择朝向后开始输出 · 按住模型拖向选择朝向，松手确认（方向键/按钮备用，Esc 取消）"
        : "选择朝向后开始输出 · 点击干员选择朝向";
    },
    open(unitId, dir) {
      const unit = state.view && state.view.units.find((u) => u.id === unitId);
      if (!unit || unit.team !== state.team) return;
      const d = dir || (this.pick && this.pick.unitId === unitId ? this.pick.dir : null)
        || facingDirName(facingUnitVec(unit)) || FACING_DEFAULT_DIR[state.team] || "right";
      this.pick = { unitId, dir: d };
      this.syncDom();
    },
    // 一次确认（松手/Enter/按钮）：只以裁决回执或权威快照为准——失败明确可重试，不做本地假成功
    confirm() {
      const p = this.pick;
      if (!p) return;
      const intent = { kind: "facing", unitId: p.unitId, dir: p.dir };
      this.intentCount += 1;
      if (state.localBattle && state.localSim) {
        const r = state.localSim.applyIntent(state.localBattle, state.team, intent);
        if (r && r.ok) {
          applySnapshot(state.localSim.snapshot(state.localBattle));   // 权威快照确认（facingConfirmed=true）
          this.pick = null;
        } else {
          log(`朝向确认被拒绝：${(r && r.reason) || "未知原因"}（可重新选择后重试）`, "bad");   // 保持待确认=可重试
        }
      } else {
        sendIntent(intent);          // 服务器裁决：intentResult/快照回执确认；拒绝由回执提示并保持待确认
        this.pick = null;
        this.ackUntil = performance.now() + 1500;
      }
      this.syncDom();
    },
    dismiss() {
      const p = this.pick;
      if (!p) return;
      this.drag = null;                 // Esc/取消：只退出预览，保持待确认（世界不停）
      const unit = state.view && state.view.units.find((u) => u.id === p.unitId);
      if (unit && unit.facingConfirmed !== true) {
        const vec = facingVecByName(p.dir) || facingUnitVec(unit);
        facingLocal.set(unit.id, { x: vec.x, y: vec.y, dir: facingDirName(vec), confirmed: false, pending: true });
      }
      this.pick = null;
      this.dismissedFor = p.unitId;
      this.snooze = { id: p.unitId, until: performance.now() + 4000 };   // 暂时收起：待确认提示持续，重选/稍后可再唤出
      this.syncDom();
    },
    handleKey(e) {
      if (!this.pick) return false;
      const dir = FACING_KEY_DIRS[e.key];
      if (dir) {
        this.pick.dir = dir;
        this.syncDom();
        e.preventDefault();
        return true;
      }
      if (e.key === "Enter") { this.confirm(); e.preventDefault(); return true; }
      if (e.key === "Escape") { this.dismiss(); e.preventDefault(); return true; }
      return false;
    },
    // —— 主操作：按住模型→朝目标屏幕方向拖动→松手一次确认（原作式拖向选向；按钮/Enter 仅备用）——
    beginAimDrag(unit, e) {
      if (!unit || unit.team !== state.team) return false;
      if (!(facingUnconfirmed(unit) || (this.pick && this.pick.unitId === unit.id))) return false;   // 已锁定单位不进选向
      selectBattleUnit(unit);   // 开始选向先明确选中目标（场上范围/左栏/脚下箭头跟随目标，不残留上一个选中）
      this.open(unit.id);
      this.drag = { unitId: unit.id, from: canvasPoint(e), moved: false };
      return true;
    },
    onAimMove(e) {
      const d = this.drag;
      if (!d || state.screen !== "battle" || !state.view) return !!d;
      const p = canvasPoint(e);
      const dx = p.x - d.from.x, dy = p.y - d.from.y;
      if (!d.moved && Math.hypot(dx, dy) > 10) d.moved = true;    // 合理拖动阈值：小幅点击不预览/不确认
      if (d.moved) {
        const unit = state.view.units.find((u) => u.id === d.unitId);
        const dir = unit ? this.aimDirFromScreen(unit, dx, dy) : null;
        if (dir && (!this.pick || this.pick.dir !== dir)) {
          this.open(d.unitId, dir);   // 候选=屏幕拖向→世界四向（按当前相机投影换算）；范围/脚下指示实时预览
        }
      }
      return true;
    },
    onAimUp() {
      const d = this.drag;
      if (!d) return false;
      this.drag = null;
      if (!d.moved) return false;        // 小幅点击=仅选中/看信息，绝不误确认
      this.confirm();                    // 松手=一次确认（裁决回执/权威快照为准）
      return true;
    },
    aimDirFromScreen(unit, dx, dy) {
      // 屏幕拖向 → 世界四向：候选方向的屏幕投影与拖向夹角最小者（三视角×红方均符合手感）
      const cam = battleCam();
      const z = heightAt(Math.round(unit.x), Math.round(unit.y));
      const a = cam.project(unit.x, unit.y, z);
      const len = Math.hypot(dx, dy) || 1;
      let best = null, bestDot = -Infinity;
      for (const name of Object.keys(FACING_DIRS)) {
        const v = FACING_DIRS[name];
        const b = cam.project(unit.x + v.x, unit.y + v.y, z);
        const sx = b.x - a.x, sy = b.y - a.y;
        const sl = Math.hypot(sx, sy) || 1;
        const dot = (dx * sx + dy * sy) / (sl * len);
        if (dot > bestDot) { bestDot = dot; best = name; }
      }
      return best;
    },
    tick(view, cam) {
      const now = performance.now();
      if (view) {
        // F5 方向锁发放（与 sim 一致）：一次确认即锁；成功高台搬运到新台（确认→未确认）发放新的一次；
        // 失败/冷却/非法落点/重复包不重置锁（快照未翻转即不发放）
        for (const u of view.units) {
          const confirmed = u.facingConfirmed !== false;
          const was = this.confirmedSeen.get(u.id);
          this.confirmedSeen.set(u.id, confirmed);
          if (u.team === state.team && was === true && !confirmed) {
            this.dismissedFor = null;
            this.open(u.id);
          }
        }
        // 新上场单位侦测：高台部署（拖卡落台）→ 紧接出现四向选择（世界不暂停、不遮挡战场）
        if (!this.seen) {
          this.seen = new Map();
          for (const u of view.units) this.seen.set(u.id, true);
        } else {
          for (const u of view.units) {
            if (this.seen.has(u.id)) continue;
            this.seen.set(u.id, true);
            const highTile = u.positionMode ? u.positionMode === "high" : isHigh(Math.round(u.x), Math.round(u.y));
            if (u.team !== state.team || !highTile) continue;
            if (u.facingConfirmed !== true) {
              const vec = facingUnitVec(u);
              if (!u.facing) facingLocal.set(u.id, { x: vec.x, y: vec.y, dir: facingDirName(vec), confirmed: false, pending: true });
              this.open(u.id);
            }
          }
          if (this.seen.size !== view.units.length) {
            for (const id of Array.from(this.seen.keys())) {
              if (view.units.some((u) => u.id === id)) continue;
              this.seen.delete(id);
              facingLocal.delete(id);
              if (this.pick && this.pick.unitId === id) this.pick = null;
            }
          }
        }
        // 选中未确认单位（台上选中未确认单位同样适用）→ 唤出四向选择；
        // 选中切走/清空即收起（不抢 Enter——行军/部署等主流程照常），重选该单位可再次唤出
        const sel = selectedUnit();
        const selId = sel ? sel.id : null;
        if (this.lastSelId !== selId) { this.lastSelId = selId; this.dismissedFor = null; }
        if (this.pick && selId && selId !== this.pick.unitId) {
          this.pick = null;            // 选中其他单位：收起选向（不抢 Enter——行军/部署主流程照常）
          this.syncDom();
        }
        const snoozed = this.snooze && this.snooze.id === selId && now < this.snooze.until;
        if (sel && facingUnconfirmed(sel) && this.dismissedFor !== sel.id && !snoozed
          && (!this.pick || this.pick.unitId !== sel.id)) {
          this.open(sel.id);
        }
        if (this.pick && !view.units.some((u) => u.id === this.pick.unitId)) this.pick = null;
        // 截图/探针只读钩子（?facingShot=pending|preview）：进战斗后自动打开一次选向面板
        if (!this.shotDone && view.units.length) {
          const shot = new URLSearchParams(location.search).get("facingShot");
          if (shot) {
            this.shotDone = true;
            const target = view.units.find((u) => u.team === state.team && (u.positionMode === "high" || isHigh(Math.round(u.x), Math.round(u.y))))
              || view.units.find((u) => u.team === state.team);
            if (target) {
              const vec = facingUnitVec(target);
              facingLocal.set(target.id, { x: vec.x, y: vec.y, dir: facingDirName(vec), confirmed: false, pending: true });
              selectBattleUnit(target);
              this.open(target.id, shot === "preview" ? "left" : "right");
            }
          }
        }
      }
      // 选向面板定位：跟随单位脚点上方（限制在顶栏/手牌栏之间，不遮挡战场、不出屏）
      if (this.pick && view && cam) {
        const unit = view.units.find((u) => u.id === this.pick.unitId);
        const el = $("facingPicker");
        if (unit && el) {
          const z = heightAt(Math.round(unit.x), Math.round(unit.y));
          const foot = cam.project(unit.x, unit.y, z);
          const r = canvas.getBoundingClientRect();
          const k = r.height / canvas.height;
          const pw = el.offsetWidth || 148, ph = el.offsetHeight || 172;
          const rawX = r.left + foot.x * (r.width / canvas.width);
          const rawY = r.top + foot.y * k - 0.8 * foot.s * k;
          const minX = r.left + pw / 2 + 8, maxX = r.right - pw / 2 - 8;
          const handEl = document.querySelector(".btHand");
          const topEl = document.querySelector(".btTop");
          const handTop = handEl ? handEl.getBoundingClientRect().top : r.bottom;
          const topBottom = topEl ? topEl.getBoundingClientRect().bottom : r.top;
          const minY = Math.max(r.top + 8, topBottom) + ph + 8, maxY = Math.min(r.bottom - 8, handTop - 8);
          el.style.left = `${Math.round(Math.max(minX, Math.min(maxX, rawX)))}px`;
          el.style.top = `${Math.round(Math.max(minY, Math.min(maxY, rawY)))}px`;
        }
      }
      this.syncDom();
    },
    previewCells() {
      const view = state.view;
      const sel = this.pick ? view && view.units.find((u) => u.id === this.pick.unitId) : selectedUnit();
      if (!sel) return [];
      const op = operator(sel.opId);
      const vec = this.vectorFor(sel);
      return facingCells(Math.round(sel.x), Math.round(sel.y), vec, shownRange(sel, op))
        .filter((c) => c.x >= 0 && c.y >= 0 && c.x < MAP_W && c.y < MAP_H);
    },
    arrowInfo(unitId) {
      const unit = state.view && state.view.units.find((u) => u.id === unitId);
      if (!unit) return null;
      const cam = battleCam();
      const z = heightAt(Math.round(unit.x), Math.round(unit.y));
      const foot = cam.project(unit.x, unit.y, z);
      const vec = this.vectorFor(unit);
      const tip = cam.project(unit.x + vec.x, unit.y + vec.y, z);
      return {
        world: { x: vec.x, y: vec.y },
        angle: Math.atan2(tip.y - foot.y, tip.x - foot.x),
        foot: { x: foot.x, y: foot.y }, tip: { x: tip.x, y: tip.y },
        confirmed: !facingUnconfirmed(unit),
      };
    },
    debug() {
      const view = state.view;
      const units = view ? view.units : [];
      const vectors = {};
      for (const u of units) {
        const v = this.vectorFor(u);
        vectors[u.id] = { x: v.x, y: v.y, confirmed: !facingUnconfirmed(u), pick: !!(this.pick && this.pick.unitId === u.id) };
      }
      // 当前/未来范围集合（只读探针：与场上两套样式的绘制同源同变换）
      const su = units.find((u) => u.id === ((this.pick && this.pick.unitId) || state.selectedUnitId));
      let rangeNow = [], rangeFuture = [];
      if (su) {
        const op = operator(su.opId);
        const sx = Math.round(su.x), sy = Math.round(su.y);
        const rng = shownRange(su, op);
        rangeNow = facingCells(sx, sy, this.currentVec(su), rng);
        const f = this.futureVec(su);
        rangeFuture = f ? facingCells(sx, sy, f, rng) : [];
      }
      return {
        pick: this.pick ? { unitId: this.pick.unitId, dir: this.pick.dir } : null,
        preview: this.previewCells(),
        intents: this.intentCount,
        pending: units.filter((u) => facingUnconfirmed(u)).map((u) => u.id),
        vectors,
        rangeNow,
        rangeFuture,
        rangeStyles: { now: "solid", future: "stripe-dashed" },
      };
    },
  };
  // 选向面板点击：方向按钮=切换候选（范围预览实时变化）；✓=确认（Enter 同）
  {
    const pickerEl = $("facingPicker");
    if (pickerEl) {
      pickerEl.addEventListener("click", (e) => {
        const dirBtn = e.target.closest("[data-dir]");
        if (dirBtn && FACING.pick) {
          FACING.pick.dir = dirBtn.dataset.dir;
          FACING.syncDom();
          return;
        }
        if (e.target.closest("#facingConfirm")) FACING.confirm();
      });
      pickerEl.addEventListener("mousedown", (e) => e.preventDefault());   // 不抢 canvas 焦点/不触发拖拽
    }
    const hintEl = $("facingHint");
    if (hintEl) hintEl.addEventListener("click", () => {   // 收起后点击提示条重新唤出
      const sel = selectedUnit();
      if (sel && facingUnconfirmed(sel)) { FACING.dismissedFor = null; FACING.snooze = null; FACING.open(sel.id); }
    });
  }

  // 脚下方向箭头（原作 sprite_direction_ring / sprite_direction_arrow）：与血条/脚影同层同投影
  // （脚点同一世界表面）。已确认=实心箭头指向 facing；待确认=方向环+四向提示闪烁（世界不暂停）。
  const facingTintCache = new Map();
  function tintedHud(name, color) {
    const img = hudTex(name);
    const key = `${name}|${color}`;
    let cv = facingTintCache.get(key);
    if (!cv) { cv = document.createElement("canvas"); facingTintCache.set(key, cv); }
    const ready = texReady(img);
    const sig = `${img && img.src}|${ready}`;
    if (cv.__sig !== sig) {
      cv.__sig = sig;
      const w = (img && img.naturalWidth) || 64, h = (img && img.naturalHeight) || 64;
      cv.width = w; cv.height = h;
      const g2 = cv.getContext("2d");
      g2.clearRect(0, 0, w, h);
      if (ready) {
        g2.drawImage(img, 0, 0, w, h);
        g2.globalCompositeOperation = "source-in";
        g2.fillStyle = color;
        g2.fillRect(0, 0, w, h);
        g2.globalCompositeOperation = "source-over";
      }
    }
    return ready ? cv : null;
  }
  // 程序化箭头（贴图未就绪兜底 + 四向提示小箭头）：尖端朝 ang 方向
  function facingChevron(g, x, y, w, h, ang, color, alpha) {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(w * 0.5, 0);
    g.lineTo(-w * 0.32, -h * 0.44);
    g.lineTo(-w * 0.08, 0);
    g.lineTo(-w * 0.32, h * 0.44);
    g.closePath();
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fill();
    g.restore();
  }
  function drawFacingArrows(g, cam, view) {
    FACING.tick(view, cam);
    if (!view) return;
    const now = performance.now();
    for (const unit of view.units) {
      const picked = !!(FACING.pick && FACING.pick.unitId === unit.id);
      const own = unit.team === state.team;
      if (!own && !picked && unit.id !== state.selectedUnitId) continue;
      const pend = facingUnconfirmed(unit) || picked;
      const z = heightAt(Math.round(unit.x), Math.round(unit.y));
      const foot = cam.project(unit.x, unit.y, z);
      if (foot.x < -80 || foot.x > canvas.width + 80 || foot.y < -80 || foot.y > canvas.height + 80) continue;
      const vec = FACING.vectorFor(unit);
      const tip = cam.project(unit.x + vec.x, unit.y + vec.y, z);
      const ang = Math.atan2(tip.y - foot.y, tip.x - foot.x);
      const flash = pend ? 0.5 + 0.42 * Math.abs(Math.sin(now / 230)) : 1;
      const color = pend ? "#ffd800" : (unit.team === "blue" ? "#8fe1ff" : "#ffa08f");
      const s = foot.s;
      // 方向环：脚点世界表面（与脚影/血条同投影同层）；暗描边保证浅色地形可辨
      const rw = 0.72 * s;
      const ringPass = (scale, color2, alpha2) => {
        const im = tintedHud("sprite_direction_ring", color2);
        if (im) {
          g.save();
          g.globalAlpha = alpha2;
          g.drawImage(im, foot.x - rw * scale / 2, foot.y - rw * scale / 2, rw * scale, rw * scale);
          g.restore();
        } else {
          g.save();
          g.globalAlpha = alpha2;
          g.strokeStyle = color2; g.lineWidth = 2.4 * scale;
          g.beginPath(); g.ellipse(foot.x, foot.y, rw * 0.5 * scale, rw * 0.22 * scale, 0, 0, Math.PI * 2); g.stroke();
          g.restore();
        }
      };
      ringPass(1.14, "#10141a", (pend ? 0.45 + 0.35 * flash : 0.3) * 0.8);
      ringPass(1, color, pend ? 0.45 + 0.35 * flash : 0.3);
      // 实心箭头：指向 facing（世界方向→屏幕角：视角/红方视角变化时世界朝向不变）
      const ax = foot.x + Math.cos(ang) * 0.58 * s, ay = foot.y + Math.sin(ang) * 0.58 * s;
      const aw = 0.36 * s, ah = 0.62 * s;
      const arrowPass = (scale, color2, alpha2) => {
        const im = tintedHud("sprite_direction_arrow", color2);
        if (im) {
          g.save();
          g.globalAlpha = alpha2;
          g.translate(ax, ay);
          g.rotate(ang);
          g.drawImage(im, -aw * scale / 2, -ah * scale / 2, aw * scale, ah * scale);
          g.restore();
        } else {
          facingChevron(g, ax, ay, aw * scale, ah * scale, ang, color2, alpha2);
        }
      };
      arrowPass(1.32, "#10141a", (pend ? 0.5 + 0.4 * flash : 0.95) * 0.7);   // 暗描边
      arrowPass(1, color, pend ? 0.5 + 0.4 * flash : 0.95);
      // 待确认=四向提示态：世界四向小箭头环绕，当前候选高亮
      if (pend) {
        for (const name of Object.keys(FACING_DIRS)) {
          const dv = FACING_DIRS[name];
          const q = cam.project(unit.x + dv.x * 0.7, unit.y + dv.y * 0.7, z);
          const a2 = Math.atan2(q.y - foot.y, q.x - foot.x);
          const cand = picked && FACING.pick.dir === name;
          const tx = foot.x + Math.cos(a2) * 0.66 * s, ty = foot.y + Math.sin(a2) * 0.66 * s;
          const cw = 0.2 * s, ch = 0.32 * s;
          facingChevron(g, tx, ty, cw * 1.35, ch * 1.35, a2, "#10141a", (cand ? 0.9 : 0.3 + 0.25 * flash) * 0.7);
          facingChevron(g, tx, ty, cw, ch, a2, cand ? "#fff6c8" : "#ffd800", cand ? 0.9 : 0.3 + 0.25 * flash);
        }
      } else {
        // 未来预览箭头（琥珀幽灵=行军后/候选方向）：与当前实心箭头区分——当前输出方向才是实心
        const fut = FACING.futureVec(unit);
        if (fut) {
          const q2 = cam.project(unit.x + fut.x, unit.y + fut.y, z);
          const a2 = Math.atan2(q2.y - foot.y, q2.x - foot.x);
          const tx = foot.x + Math.cos(a2) * 0.52 * s, ty = foot.y + Math.sin(a2) * 0.52 * s;
          facingChevron(g, tx, ty, 0.16 * s, 0.16 * s, a2, "#10141a", 0.5);
          facingChevron(g, tx, ty, 0.13 * s, 0.13 * s, a2, "#e8b400", 0.55);
        }
      }
    }
  }

  // ---------------- 部署区高亮（G1/G2）+ 高台搬运拖移（G3） ----------------
  // 部署区数据可视化：maps.json「初始部署区」字段未到前用 inHalf+groundDeploy/highDeploy 组合（字段落地后换数据源）。
  // G1 地面初始可部署格=常驻合并描边（连续区块化一框到底，不是逐格小方块）；
  // G2 选中高台干员（手牌选中/拖放）或高台搬运上下文=高台可放位高亮（区分样式），地面框不消失；
  // G3 选中在台干员后直接拖到目标高台锚点=搬运（与 R+点击同一通道/合法性，非法落点给提示）。
  const HIGHDRAG = {
    active: null,   // { unitId, from, tile, moved }
    begin(unit, e) {
      // 只有在搬运模式下才能拖动（需要先点击按钮）
      if (!state.highMoveMode) return false;
      if (!unit || unit.team !== state.team || unit.positionMode !== "high"
        || !unit.highMoveAllowed || unit.highMoveCooldown > 0) return false;
      if (state.highTarget !== unit.id) return false;
      this.active = { unitId: unit.id, from: canvasPoint(e), tile: null, moved: false };
      return true;
    },
    onMove(e) {
      const d = this.active;
      if (!d || state.screen !== "battle" || !state.view) return !!d;
      const p = canvasPoint(e);
      if (!d.moved && Math.hypot(p.x - d.from.x, p.y - d.from.y) > 8) d.moved = true;
      if (d.moved) {
        const t = tileAt(p);
        d.tile = t && highMoveAnchorOk(d.unitId, t) ? t : null;
      }
      return true;
    },
    onUp() {
      const d = this.active;
      if (!d) return false;
      this.active = null;
      state.highMoveMode = false;  // 退出搬运模式
      
      if (!d.moved) return false;              // 未拖动=点选，交还点击
      ROUTE.suppressClick = true;
      
      if (d.tile) {
        // 检查费用
        const HIGHMOVE_COST = 3;
        const currentCost = state.view ? state.view.cost[state.team] : 99;
        if (currentCost < HIGHMOVE_COST) {
          log(`费用不足（需要 ${HIGHMOVE_COST}，当前 ${currentCost}）`, "bad");
          return true;
        }
        
        // 本地模拟扣费
        if (state.localBattle) {
          state.localBattle.cost[state.team] -= HIGHMOVE_COST;
        }
        
        moveHighUnit(d.unitId, d.tile);
        log(`搬运至 (${d.tile.x},${d.tile.y})，消耗 ${HIGHMOVE_COST} 费用`, "sys");
      } else {
        log("请拖到空闲的己方高台锚点", "bad");
      }
      return true;
    },
  };
  function highMoveAnchorOk(unitId, t) {
    // 与服务器 highMove 判定同源（预览=裁决）：高台格 ∧ 己方半场 ∧ zones.initialDeploy ∧ 无占位 ∧ 非自身格（同格=无操作）
    const m = currentMap();
    if (!m.highDeploy(t.x, t.y) || !m.inHalf(state.team, t.x)) return false;
    if (!inInitialZone(t.x, t.y)) return false;
    const self = state.view && state.view.units.find((u) => u.id === unitId);
    if (self && Math.round(self.x) === t.x && Math.round(self.y) === t.y) return false;
    return !state.view.units.some((u) => u.id !== unitId && Math.round(u.x) === t.x && Math.round(u.y) === t.y);
  }

  const zoneCache = { key: "", cv: document.createElement("canvas") };
  // 合并区块化描边：只画集合边界边（邻格不在集合内）——相邻可放格合成一个连续框
  function strokeZone(g, cam, cells, fill, stroke, lineWidth) {
    g.save();
    for (const k of cells) {
      const x = k % 4096, y = (k / 4096) | 0;
      const q = PROJ.tileQuad(cam, x, y, heightAt(x, y), 0.03);
      if (fill) { g.fillStyle = fill; drawQuad(q, fill, null, 1, g); }
    }
    g.beginPath();
    for (const k of cells) {
      const x = k % 4096, y = (k / 4096) | 0;
      const z = heightAt(x, y), a = 0.5;
      const c00 = cam.project(x - a, y - a, z), c10 = cam.project(x + a, y - a, z);
      const c11 = cam.project(x + a, y + a, z), c01 = cam.project(x - a, y + a, z);
      if (!cells.has((y - 1) * 4096 + x)) { g.moveTo(c00.x, c00.y); g.lineTo(c10.x, c10.y); }
      if (!cells.has((y + 1) * 4096 + x)) { g.moveTo(c01.x, c01.y); g.lineTo(c11.x, c11.y); }
      if (!cells.has(y * 4096 + x - 1)) { g.moveTo(c00.x, c00.y); g.lineTo(c01.x, c01.y); }
      if (!cells.has(y * 4096 + x + 1)) { g.moveTo(c10.x, c10.y); g.lineTo(c11.x, c11.y); }
    }
    g.lineWidth = lineWidth;
    g.strokeStyle = stroke;
    g.stroke();
    g.restore();
  }
  // 部署区数据源（F11）：与 maps.json zones.initialDeploy 同源（矩形含端点）；地图未带 zones → 回退 inHalf 半场
  function initialDeployRects(team) {
    const mapId = (state.view && state.view.mapId) || (state.localBattle && state.localBattle.mapId) || "cross";
    const m = currentMap();
    const raw = (window.AKF_MAPS && Array.isArray(window.AKF_MAPS.maps) && window.AKF_MAPS.maps.find((mm) => mm.id === mapId)) || null;
    const z = (m && m.zones && m.zones.initialDeploy) || (raw && raw.zones && raw.zones.initialDeploy) || null;
    return (z && (z[team] || z[state.team])) || null;
  }
  function inInitialZone(x, y, team) {
    // 与服务端判定同源（sim.js 的 inInitialDeploy）：地面只认 zones.initialDeploy 矩形（各图门口的限定位置），
    // 高台（远程位）在己方半场任意位置可用。两边必须一致，否则会出现「高亮不出格子 / 点了放不下去」。
    const m = currentMap();
    if (m && typeof m.inInitialDeploy === "function") return m.inInitialDeploy(team || state.team, x, y);
    const rects = initialDeployRects(team || state.team);
    if (!rects || !rects.length) return true;
    return rects.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  }
  function deployZones() {
    // 部署区数据（G1-G3 高亮 + 拖卡点亮/合法性判定同源）
    const m = currentMap();
    const ground = new Set(), high = new Set();
    for (let y = 0; y < m.height; y += 1) {
      for (let x = 0; x < m.width; x += 1) {
        if (!m.inHalf(state.team, x) || !inInitialZone(x, y)) continue;
        const k = y * 4096 + x;
        if (m.groundDeploy(x, y)) ground.add(k);
        if (m.highDeploy(x, y)) high.add(k);
      }
    }
    return { ground, high };
  }
  function drawDeployZones(g, cam, key, descendOptions) {
    const deployOp = operator(state.cardDrag?.opId || state.selectedOpId);
    const selU = selectedUnit();
    // 修复：选中高台干员时也高亮高台区域
    const highCtx = !!((deployOp && deployOp.high) || state.highTarget || HIGHDRAG.active
      || (selU && selU.team === state.team && selU.positionMode === "high"));
    const drop = HIGHDRAG.active && HIGHDRAG.active.tile;
    const zkey = `${key}|zones|${highCtx ? 1 : 0}|${state.descendTarget ? `d${state.descendTarget}` : ""}|${drop ? `${drop.x},${drop.y}` : ""}`;
    const cg = cacheCanvasFor(zoneCache, zkey);
    if (cg) {
      const { ground, high } = deployZones();
      strokeZone(cg, cam, ground, "rgba(83,220,160,.10)", "rgba(115,255,196,.55)", 2);       // 地面：常驻合并框
      if (highCtx) strokeZone(cg, cam, high, "rgba(255,196,60,.18)", "rgba(255,216,0,.9)", 2.5);  // 高台：增强高亮显示
      for (const t of descendOptions) {                                                        // F 下地落点
        drawQuad(PROJ.tileQuad(cam, t.x, t.y, heightAt(t.x, t.y), .03), "rgba(83,220,160,.15)", "rgba(115,255,196,.45)", 1, cg);
      }
      if (drop) {                                                                              // G3 拖移落点
        drawQuad(PROJ.tileQuad(cam, drop.x, drop.y, heightAt(drop.x, drop.y), .02), "rgba(80,210,160,.25)", "#8dffd5", 3, cg);
      }
    }
    g.drawImage(zoneCache.cv, 0, 0);
  }

  // ---------------- 战斗：选中叠层 / 底部部署卡 / 日志 ----------------
  function shownRange(unit, op) {
    const skill = unit && carriedSkill(unit);
    return unit?.skillActive && skill?.rangeGrid?.length ? skill.rangeGrid : op.rangeGrid?.length ? op.rangeGrid : [{row:0,col:0},{row:0,col:1}];
  }
  function drawRangeMini(op, unit) {
    const cv = $("uoRangeCanvas");
    const g = cv.getContext("2d");
    const range = shownRange(unit, op);
    // 四向变换（与场上斜纹同源）：范围偏移 (col,row) → 世界偏移；小图按世界方位显示（+y 朝上）
    const vec = FACING.vectorFor(unit);
    const cells = range.map((t) => ({ x: t.col * vec.x - t.row * vec.y, y: t.col * vec.y + t.row * vec.x }));
    const minX = Math.min(0, ...cells.map(t=>t.x)) - 1, maxX = Math.max(0, ...cells.map(t=>t.x)) + 1;
    const minY = Math.min(0, ...cells.map(t=>t.y)) - 1, maxY = Math.max(0, ...cells.map(t=>t.y)) + 1;
    const cols = maxX-minX+1, rows = maxY-minY+1, cell = Math.min(cv.width/cols, cv.height/rows);
    const ox=(cv.width-cols*cell)/2, oy=(cv.height-rows*cell)/2;
    g.clearRect(0, 0, cv.width, cv.height);
    let pattern = null;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = ox+(x-minX)*cell+1, py = oy+(maxY-y)*cell+1, pw = cell-2, ph = cell-2;
        if (x===0&&y===0) { g.fillStyle = "#232323"; g.fillRect(px, py, pw, ph); continue; }
        if (!cells.some(t=>t.x===x&&t.y===y)) { g.fillStyle = "#e2e2e2"; g.fillRect(px, py, pw, ph); continue; }
        g.fillStyle = "#ffd800";
        g.fillRect(px, py, pw, ph);
        // 斜纹与场上同源：同一 sprite_attack_range 图案（按小图比例缩放）
        if (!pattern) {
          pattern = getStripePattern(g);
          if (pattern && pattern.setTransform) {
            const k = Math.max(0.12, Math.min(0.42, cell / 26));
            try { pattern.setTransform(new DOMMatrix([k, 0, 0, k, 0, 0])); } catch { /* 不支持变换时用原比例 */ }
          }
        }
        if (pattern) {
          g.save();
          g.globalAlpha = 0.55;
          g.fillStyle = pattern;
          g.fillRect(px, py, pw, ph);
          g.restore();
        }
      }
    }
  }

  function updateUnitInfo() {
    const unit = selectedUnit();
    const overlay = $("unitOverlay");
    const own = unit && unit.team === state.team;
    $("highMoveButton").classList.toggle("hidden", !own || !unit.highMoveAllowed);
    $("highMoveButton").disabled = !!unit && unit.highMoveCooldown > 0;
    $("highMoveButton").textContent = unit?.highMoveCooldown > 0 ? `搬运冷却 ${unit.highMoveCooldown}s` : "R · 高台搬运";
    $("descendButton").classList.toggle("hidden", !own || unit.positionMode !== "high" || !operator(unit.opId)?.high);
    $("descendButton").disabled = !own || !descendTiles(unit).length;
    $("descendButton").title = own && unit.positionMode === "high" && !descendTiles(unit).length ? "没有相邻地面落点，可先搬运至高台边缘" : "选择一个相邻地面落点";
    $("highMoveButton").classList.toggle("active", !!unit && state.highTarget === unit.id);
    $("descendButton").classList.toggle("active", !!unit && state.descendTarget === unit.id);
    $("retreatButton").classList.toggle("hidden", !own || unit.retreatable === false);
    $("marchButton").classList.toggle("hidden", !own || !unit.marchAllowed);
    $("marchButton").disabled = !ROUTE.draftUnitId || !state.routeDraft.length;
    const modeBadge = $("unitModeBadge");
    if (modeBadge) modeBadge.textContent = own ? (state.highTarget ? "选择目标高台" : state.descendTarget ? "选择高亮的相邻地面" : unit.positionMode === "high" ? "高台驻防" : unit.followOf ? "跟随中" : unit.marchAllowed ? "地面驻守 · 可选择线路" : { moving: "行军中", following: "跟随中", engaged: "交战中", healing: "治疗中", casting: "技能生效中", blocked: "被阻挡", idle: "驻守中" }[unit.stopReason] || "地面行动") : "";
    if (!own) {
      if (!overlay.classList.contains("hidden")) overlay.classList.add("hidden");
      return;
    }
    const op = operator(unit.opId);
    const art = $("uoArt"), artUrl = `assets/art/${op.id}_big.webp`;
    if (art.dataset.source !== artUrl || (art.dataset.failedAt && Date.now() - Number(art.dataset.failedAt) > 30000)) {
      art.dataset.source = artUrl;
      delete art.dataset.failedAt;
      art.style.visibility = "hidden";
      art.onload = () => { art.style.visibility = "visible"; delete art.dataset.failedAt; };
      art.onerror = () => { art.dataset.failedAt = String(Date.now()); art.style.visibility = "hidden"; };
      art.src = artUrl;
    }
    $("uoName").textContent = op.name;
    $("uoLevel").textContent = `${op.role} · ${unit.positionMode === "high" ? "高台驻防" : "地面行动"}`;
    $("uoAtk").textContent = op.atk;
    $("uoDef").textContent = unit.effDef == null ? op.def : unit.effDef;
    $("uoRes").textContent = unit.effRes == null ? op.res : unit.effRes;
    $("uoBlock").textContent = unit.blockedBy ? `${op.block}（交战中）` : op.block;
    $("uoHp").textContent = `${unit.hp}/${unit.maxHp}`;
    const sk = (op.skills && op.skills[unit.skillIndex || 0]) || op.skill;
    $("uoSkillName").textContent = sk.name || op.skill.name;
    const controls = SKILL_CONTROLS[sk.id] || {};
    $("uoSpType").textContent = String(sk.spType).includes("ATTACK") ? "攻击回复" : /HIT|DAMAGE|HURT/.test(String(sk.spType)) ? "受击回复" : "自动回复";
    $("uoTriggerType").textContent = controls.trigger === "AUTO" ? "自动触发" : controls.trigger === "PASSIVE" ? "被动" : "手动触发 · E";
    $("uoSkillTime").textContent = `${sk.spCost || op.skill.spCost}技力`;
    $("uoSkillDesc").textContent = (sk.desc || op.skill.desc || "").replace(/<[^>]+>/g, "");
    const btn = $("uoSkillButton");
    const ready = unit.sp >= unit.spCost && !unit.skillActive;
    btn.disabled = !manualSkill(unit) || !ready;
    btn.querySelector("b").textContent = manualSkill(unit) ? "E" : controls.trigger === "PASSIVE" ? "被动" : "自动";
    btn.classList.toggle("ready", ready && manualSkill(unit));
    btn.classList.toggle("cooling", !ready && !unit.skillActive);
    btn.classList.toggle("active", unit.skillActive);
    $("uoSkillState").textContent = unit.skillActive ? "技能生效中" : !manualSkill(unit) ? (controls.trigger === "PASSIVE" ? "被动" : "自动触发") : ready ? "技能就绪" : `${Math.floor(unit.sp)}/${unit.spCost}`;
    $("uoSpValue").textContent = `${Math.floor(unit.sp)}/${unit.spCost}`;
    $("uoSpFill").style.width = `${Math.max(0, Math.min(100, 100 * unit.sp / Math.max(1, unit.spCost)))}%`;
    $("uoSpFill").closest(".uoSp").classList.toggle("ready", ready);
    const iconUrl = controls.icon || `assets/skills/skill_icon_${sk.id || controls.iconId || sk.iconId}.webp`;
    if ($("uoSkillIcon").dataset.src !== iconUrl) {
      $("uoSkillIcon").dataset.src = iconUrl;
      $("uoSkillIcon").replaceChildren(Object.assign(document.createElement("img"), { src: iconUrl, alt: sk.name }));
    }
    drawRangeMini(op, unit);

    // 页签：技能 / 特性 / 天赋
    state.unitTab = state.unitTab || "skill";
    document.querySelectorAll(".uoTab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === state.unitTab);
    });
    const skillIcon = $("uoSkillIcon").parentElement;
    if (state.unitTab === "skill") {
      skillIcon.style.display = "";
      btn.style.display = "";
      $("uoSkillIcon").style.display = "";
    } else {
      btn.style.display = "none";
      $("uoSkillIcon").style.display = "none";
      const body = $("uoSkillName");
      if (state.unitTab === "trait") {
        body.textContent = "特性";
        $("uoSpType").textContent = "职业特性";
        $("uoSkillTime").textContent = "";
        $("uoSkillDesc").textContent = op.trait || `阻挡 ${op.block} 名敌人，攻击至多 ${op.atkTargets || 1} 个目标。`;
      } else {
        body.textContent = "天赋";
        $("uoSpType").textContent = "被动";
        $("uoSkillTime").textContent = "";
        const talents = (op.talents || []).map((t) => `${t.name}：${t.desc}`).join("；");
        $("uoSkillDesc").textContent = talents || "无天赋数据。";
      }
    }
    if (overlay.classList.contains("hidden")) overlay.classList.remove("hidden");
  }

  function renderHand() {
    const view = state.view;
    if (!view) return;
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "Q", "W"];
    const hand = view.hand[state.team];
    const onField = new Set(view.units.filter((u) => u.team === state.team).map((u) => u.opId));
    $("deploySlots").textContent = Math.max(0, hand.length - onField.size);

    // 只在「卡片集合或顺序」变化时重建节点：快照 10Hz 下发、再部署倒计时每秒 -1，
    // 若每次都重建 innerHTML，卡片入场动画（handCardEnter）会不断重播、头像也要重新解码 → 肉眼可见的每秒抖动。
    const host = $("hand");
    const structSig = `${state.team}|${hand.map((s) => s.opId).join(",")}`;
    if (state.handStructSig !== structSig && !state.cardDrag) {
      state.handStructSig = structSig;
      host.innerHTML = hand.map((slot, i) => {
        const op = operator(slot.opId);
        return `
        <button class="handButton" data-id="${slot.opId}">
          <img src="assets/avatars/${op.id}.webp" alt="${op.name}" draggable="false">
          <span class="hbCost">${keys[i]} · ${slot.cost ?? op.cost}</span>
          <span class="hbRole">${op.role}</span>
          <span class="hbName">${op.name}</span>
        </button>
      `;
      }).join("");
    }

    // 原地更新状态（不销毁节点 → 不重播动画、不重新解码头像）
    hand.forEach((slot, i) => {
      const btn = host.children[i];
      if (!btn) return;
      const op = operator(slot.opId);
      const affordable = view.cost[state.team] >= (slot.cost ?? op.cost);
      const isOnField = onField.has(op.id);
      const cooling = slot.readyIn > 0;
      btn.classList.toggle("active", state.selectedOpId === slot.opId);
      btn.classList.toggle("dead", cooling);
      btn.classList.toggle("cooldown", cooling);
      btn.classList.toggle("onField", isOnField);
      btn.classList.toggle("unaffordable", !affordable);
      btn.classList.toggle("insufficient", !affordable);
      btn.title = `${op.name}${isOnField ? " · 在场，点击选中" : " · 拖动部署"}`;
      let cd = btn.querySelector(".hbCd");
      if (cooling) {
        if (!cd) { cd = document.createElement("span"); cd.className = "hbCd"; btn.appendChild(cd); }
        const txt = `${slot.readyIn}s`;
        // 改写既有文本节点的值（避免 textContent= 反复替换文本节点造成无谓的 DOM 变动）
        if (cd.firstChild && cd.firstChild.nodeType === 3) {
          if (cd.firstChild.nodeValue !== txt) cd.firstChild.nodeValue = txt;
        } else {
          cd.textContent = txt;
        }
      } else if (cd) cd.remove();
      let of = btn.querySelector(".hbOnField");
      if (isOnField) {
        if (!of) { of = document.createElement("span"); of.className = "hbOnField"; of.textContent = "在场"; btn.appendChild(of); }
      } else if (of) of.remove();
    });
  }

  function selectHandCard(opId) {
    const onField = state.view?.units.find((u) => u.team === state.team && u.opId === opId);
    if (onField) { selectBattleUnit(onField); return; }
    state.selectedOpId = opId;
    state.selectedUnitId = null;
    ROUTE.clearDraft();
    updateUnitInfo();
    renderHand();
    canvas.focus({ preventScroll: true });
  }
  $("hand").addEventListener("click", (e) => {
    if (state.suppressHandClick) { state.suppressHandClick = false; return; }
    const b = e.target.closest(".handButton");
    if (b) selectHandCard(b.dataset.id);
  });
  $("hand").addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".handButton");
    if (!b || e.button !== 0 || state.screen !== "battle") return;
    state.suppressHandClick = false;
    const slot = state.view.hand[state.team].find((h) => h.opId === b.dataset.id);
    if (!slot || slot.readyIn > 0 || state.view.units.some((u) => u.team === state.team && u.opId === slot.opId)) return;
    state.cardDrag = { opId: b.dataset.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, tile: null };
    b.setPointerCapture(e.pointerId);
  });
  window.addEventListener("pointermove", (e) => {
    const drag = state.cardDrag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 7) drag.active = true;
    if (!drag.active) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    drag.tile = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY < document.querySelector(".btHand").getBoundingClientRect().top ? tileAt(canvasPoint(e)) : null;
    let ghost = $("deployDragPreview");
    if (!ghost) {
      ghost = document.createElement("div"); ghost.id = "deployDragPreview"; ghost.className = "deployDragPreview";
      ghost.append(Object.assign(document.createElement("img"), { src: `assets/avatars/${drag.opId}.webp`, alt: operator(drag.opId).name }));
      document.body.append(ghost);
    }
    ghost.style.left = `${e.clientX}px`; ghost.style.top = `${e.clientY}px`;
    const t = drag.tile, m = currentMap(), op = operator(drag.opId);
    const slot = state.view.hand[state.team].find((h) => h.opId === drag.opId);
    drag.valid = !!t && m.inHalf(state.team, t.x) && inInitialZone(t.x, t.y) && (op.high ? m.highDeploy(t.x, t.y) || m.groundDeploy(t.x, t.y) : m.groundDeploy(t.x, t.y)) && !state.view.units.some((u) => Math.round(u.x) === t.x && Math.round(u.y) === t.y) && state.view.cost[state.team] >= (slot.cost ?? op.cost);
    ghost.classList.toggle("valid", drag.valid); ghost.classList.toggle("invalid", !drag.valid);
  }, { passive: false });
  window.addEventListener("pointerup", (e) => {
    const drag = state.cardDrag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    state.cardDrag = null;
    $("deployDragPreview")?.remove();
    state.handStructSig = null;
    if (drag.active) {
      state.suppressHandClick = true;
      if (drag.valid) deployAt(drag.opId, drag.tile);
      else log("请选择己方可用的部署格", "bad");
    } else {
      // 轻点=选卡：直接在 pointerup 内选中（随后 renderHand 重绘会替换按钮节点、
      // 吞掉紧随的 click 事件——不依赖 click 通道；suppressHandClick 防止双重选中）
      state.suppressHandClick = true;
      selectHandCard(drag.opId);
    }
    renderHand();
  });
  window.addEventListener("pointercancel", () => { state.cardDrag = null; $("deployDragPreview")?.remove(); state.handSignature = null; renderHand(); });

  function log(text, tone = "") {
    state.clientLog = state.clientLog || [];
    state.clientLog.unshift({ text, tone, t: state.view ? state.view.elapsed : 0 });
    state.clientLog = state.clientLog.slice(0, 40);
    syncLogFromView();
  }

  function syncLogFromView() {
    const view = state.view;
    const serverEvents = (view && view.events) || [];
    const merged = [...(state.clientLog || []), ...serverEvents].slice(0, 20);
    $("log").innerHTML = merged.map((l) => `<div class="${l.tone || ""}">${l.text}</div>`).join("");
    // 原作式瞬时提示：不常驻日志栏
    const area = $("toastArea");
    const latest = merged[0];
    if (latest && latest.text !== state.lastToast) {
      state.lastToast = latest.text;
      const toast = document.createElement("div");
      toast.className = `toast ${latest.tone || ""}`;
      toast.textContent = latest.text;
      area.prepend(toast);
      while (area.children.length > 3) area.removeChild(area.lastChild);
      setTimeout(() => toast.classList.add("fade"), 3200);
      setTimeout(() => toast.remove(), 4000);
    }
  }

  // ---------------- 结算（浅色结算卡） ----------------
  function showResult(snap, winner) {
    const draw = winner === "draw";
    const win = draw ? false : winner === state.team;
    const card = $("resultCard");
    card.className = `resultCard ${draw ? "draw" : win ? "win" : "lose"}`;
    $("resultTitle").textContent = draw ? "OPERATION DRAW" : win ? "OPERATION SUCCESS" : "OPERATION FAILED";
    $("resultSub").textContent = draw ? "双方目标生命同时归零 · 平局" : win ? "敌方蓝门攻破 · 作战胜利" : "己方蓝门陷落 · 作战失败";
    $("resultTime").textContent = formatTime(snap ? snap.elapsed : 0);
    $("resultBlueHp").textContent = snap ? snap.gateHp.blue : 0;
    $("resultRedHp").textContent = snap ? snap.gateHp.red : 0;
    $("resultRestart").style.display = state.host ? "" : "none";
    $("resultOverlay").classList.remove("hidden");
    state.resultShown = true;
  }

  function hideResult() {
    $("resultOverlay").classList.add("hidden");
    state.resultShown = false;
  }

  $("resultRestart").addEventListener("click", () => {
    hideResult();
    send({ type: "startBattle" });      // 房主发起：重新进入服务器选人
    switchScreen("draft");
  });
  $("resultHome").addEventListener("click", () => {
    hideResult();
    send({ type: "leaveRoom" });
    switchScreen("home");
  });

  // ---------------- 战斗：棋盘渲染（浅色原作视角） ----------------
  // 性能：绘制工具函数接受目标上下文 g（默认主画布），静态地形/选中叠层可绘制到离屏缓存复用。
  function drawRounded(x, y, w, h, r, g = ctx) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawQuad(quad, fill, stroke, lineWidth, g = ctx) {
    g.beginPath();
    for (let i = 0; i < quad.length; i += 1) {
      const pt = quad[i];
      if (i) g.lineTo(pt.x, pt.y); else g.moveTo(pt.x, pt.y);
    }
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lineWidth || 1; g.stroke(); }
  }

  function drawEdge(g, p, q, color, w) {
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y);
    g.strokeStyle = color; g.lineWidth = w; g.stroke();
  }

  // ---------------- 原作场景贴图（map_battleground 主题，Ark-Unpacker/LZ4AK 只读提取） ----------------
  // 贴图缓存（性能）：预加载清单一次性拉取；加载失败打 __failed 占位标（不逐帧重试、不重复建 Image）；
  // drawTexturedQuad 对失败/未就绪贴图用纯色占位，pattern/gradient 一律复用（见 getStripePattern/fxGlow）。
  const TEX = {};
  const HUD_TEX = {};
  function makeTex(map, dir, name) {
    let img = map[name];
    if (!img) {
      img = new Image();
      img.__failed = false;
      img.addEventListener("error", () => { img.__failed = true; });
      img.src = `assets/${dir}/${name}.png`;
      map[name] = img;
    }
    return img;
  }
  function tex(name) {
    // 命中主题槽时改读 theme_<id>/<slot>.png；缺槽/无主题回退基准贴图
    const th = themeCfg();
    const mapped = (th && th.files && th.files[name]) || name;
    return makeTex(TEX, "scene", mapped);
  }
  function hudTex(name) { return makeTex(HUD_TEX, "hud", name); }
  const texReady = (img) => !!img && !img.__failed && img.complete && img.naturalWidth > 0;
  // —— 地图环境主题（材质套/光照色调/装饰调色）：public/maps.js 由 生成脚本 汇总
  // theme_<id>/manifest.json（生成脚本 自原作场景包提取）生成。
  // tex(name) 仍按基准名调用；命中主题槽时改读 theme_<id>/<slot>.png，缺槽回退基准贴图。
  const DEFAULT_LIGHT = {
    groundTint: null, pathTint: "rgba(120,150,190,.10)", platformTint: "rgba(20,28,44,.10)",
    wallTint: "rgba(12,14,18,.35)",
    sideShades: ["rgba(10,12,16,.42)", "rgba(10,12,16,.20)", "rgba(6,8,12,.55)", "rgba(6,8,12,.35)"],
    vignette: ["rgba(10,12,18,.62)", "rgba(10,12,18,.28)", "rgba(8,10,14,.66)"],
    bgBase: "#14161b", colorTemp: null,
  };
  const DEFAULT_DECOR = { primary: "#8a929c", secondary: "#5c646e", dark: "#2c3238", accent: "#c8a24a" };
  const themeMemo = { id: undefined, cfg: null, decor: null };
  function themeCfg() {
    const mapId = currentMap().id;
    if (themeMemo.id !== mapId) {
      const pack = window.AKF_MAPS || {};
      const themes = pack.themes || {};
      const m = (pack.maps || []).find((mm) => mm.id === mapId) || null;
      themeMemo.id = mapId;
      themeMemo.cfg = (m && themes[m.theme]) || null;
      const dmap = new Map();
      if (m && Array.isArray(m.decor)) for (const d of m.decor) dmap.set(d.y * 4096 + d.x, d.kind);
      themeMemo.decor = dmap;
    }
    return themeMemo.cfg;
  }
  function decorKindAt(x, y) {
    themeCfg();
    return themeMemo.decor.get(y * 4096 + x) || null;
  }
  // 预加载清单：进战场前一次性请求全部场景/HUD 贴图（失败即占位，不阻塞渲染）
  const TEX_PRELOAD = ["TX_Battleground_BG", "tile_ground_top", "tile_ground_top2", "tile_platform_top", "tile_platform_top2", "tile_wall_side", "prop_crate"];
  const HUD_PRELOAD = ["sprite_box_shadow", "sprite_attack_range", "sprite_direction_ring", "sprite_direction_arrow", "sprite_shadow", "projectile_arrow_new", "projectile_crossbow_new", "projectile_yuki", "img_fx_light_01", "img_fx_light_02", "trail_11", "fx"];
  for (const n of TEX_PRELOAD) tex(n);
  for (const n of HUD_PRELOAD) hudTex(n);
  // 贴图就绪签名：任一贴图加载完成/失败时使静态地形缓存失效重建；主题切换同样触发重建
  function texSig() {
    let s = (themeCfg() && themeCfg().id) || "base";
    for (const n of Object.keys(TEX)) s += n + (texReady(TEX[n]) ? "1" : "0");
    for (const n of HUD_PRELOAD) s += texReady(HUD_TEX[n]) ? "1" : "0";
    return s;
  }

  // 仿射贴图：把贴图矩形映射到四边形（平行四边形顶面精确成立）
  function drawTexturedQuad(quad, img, tint, g = ctx) {
    const [a, b, c, d] = quad;
    g.save();
    g.beginPath();
    g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y); g.lineTo(d.x, d.y);
    g.closePath();
    g.clip();
    if (texReady(img)) {
      const w = img.naturalWidth, h = img.naturalHeight;
      g.setTransform((b.x - a.x) / w, (b.y - a.y) / w, (d.x - a.x) / h, (d.y - a.y) / h, a.x, a.y);
      g.drawImage(img, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      g.fillStyle = "#2c3238";   // 贴图未就绪/加载失败的纯色占位
      g.fill();
    }
    if (tint) { g.fillStyle = tint; g.fill(); }
    g.restore();
  }

  // 世界立方体顶点 → 屏幕
  function projPt(cam, x, y, z) { return cam.project(x, y, z); }

  // 高度侧壁（朝相机的面），贴原作墙面贴图并按主题光照加深
  function drawTileSides(cam, x, y, z, half, g = ctx) {
    if (z <= 0) return;
    const sh = ((themeCfg() && themeCfg().light) || DEFAULT_LIGHT).sideShades || DEFAULT_LIGHT.sideShades;
    const top = [
      projPt(cam, x - half, y - half, z), projPt(cam, x + half, y - half, z),
      projPt(cam, x + half, y + half, z), projPt(cam, x - half, y + half, z),
    ];
    const bot = [
      projPt(cam, x - half, y - half, 0), projPt(cam, x + half, y - half, 0),
      projPt(cam, x + half, y + half, 0), projPt(cam, x - half, y + half, 0),
    ];
    const cx = cam.p[0], cy = cam.p[1];
    const faces = [];
    if (cy < y - half) faces.push({ q: [top[0], top[1], bot[1], bot[0]], shade: sh[0] });
    if (cx > x + half) faces.push({ q: [top[1], top[2], bot[2], bot[1]], shade: sh[1] });
    if (cy > y + half) faces.push({ q: [top[2], top[3], bot[3], bot[2]], shade: sh[2] });
    if (cx < x - half) faces.push({ q: [top[3], top[0], bot[0], bot[3]], shade: sh[3] });
    const sv = tileVariation(x, y);
    const ja = sv.tone >= 0.25 ? (0.012 + sv.tone * 0.035).toFixed(3) : null;
    for (const f of faces) {
      drawTexturedQuad(f.q, tex("tile_wall_side"), f.shade, g);
      // 侧壁同材质微变化（不改几何）：亮度微抖动随格哈希稳定复现
      if (ja) drawQuad(f.q, sv.rot & 1 ? `rgba(255,255,255,${ja})` : `rgba(0,0,0,${ja})`, null, 1, g);
    }
  }

  // 原作攻击范围斜纹（sprite_attack_range 原图）；未加载时退回程序纹路。
  // pattern 复用：源画布只在贴图就绪状态翻转时重建，pattern 按目标上下文缓存（WeakMap）。
  let stripeSrc = null, stripeSrcState = null;
  const stripePatternByCtx = new WeakMap();
  function stripeSource() {
    const img = hudTex("sprite_attack_range");
    const st = texReady(img) ? "img" : "fallback";
    if (stripeSrc && stripeSrcState === st) return stripeSrc;
    stripeSrcState = st;
    const p = document.createElement("canvas");
    if (st === "img") {
      p.width = 96; p.height = 96;
      p.getContext("2d").drawImage(img, 0, 0, 96, 96);
    } else {
      p.width = 12;
      p.height = 12;
      const g = p.getContext("2d");
      g.fillStyle = "rgba(64,150,220,.20)";
      g.fillRect(0, 0, 12, 12);
      g.strokeStyle = "rgba(96,190,255,.65)";
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(-4, 12); g.lineTo(12, -4);
      g.moveTo(2, 16); g.lineTo(16, 2);
      g.stroke();
    }
    stripeSrc = p;
    return p;
  }
  function getStripePattern(g = ctx) {
    const src = stripeSource();
    let cached = stripePatternByCtx.get(g);
    if (!cached || cached.src !== src) {
      cached = { src, pattern: g.createPattern(src, "repeat") };
      stripePatternByCtx.set(g, cached);
    }
    return cached.pattern;
  }

  // 性能：静态地形（背景贴图+渐变+全部地块）与选中范围叠层离屏缓存。
  // 仅当相机/地图/画布尺寸/贴图就绪签名（地形）或选中状态（叠层）变化才重建，每帧各一次 drawImage；
  // 每帧分配（tiles 数组/临时对象/闭包）只发生在缓存重建帧，热帧不再分配。
  const terrainCache = { key: "", cv: document.createElement("canvas") };
  const overlayCache = { key: "", cv: document.createElement("canvas") };
  function cacheCanvasFor(cache, key) {
    if (cache.key === key) return null;
    cache.key = key;
    if (cache.cv.width !== canvas.width || cache.cv.height !== canvas.height) {
      cache.cv.width = canvas.width;
      cache.cv.height = canvas.height;
    }
    const g = cache.cv.getContext("2d");
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.clearRect(0, 0, cache.cv.width, cache.cv.height);
    return g;
  }

  function renderTerrainTo(g, cam) {
    const W = canvas.width, H = canvas.height;
    // 相机下沿适配：场景（背景贴图+暗角+地块）限制在 cam.viewport 内；viewport 之下（HUD/手牌区）
    // 只留主题纯色衬底，地形不越下沿与 HUD 互盖（相机逻辑不在本区，此处仅地形绘制对下沿适配）。
    const vp = cam.viewport || { x: 0, y: 0, width: W, height: H };
    // 背景：主题场景背景贴图（cover）+ 主题暗角压暗，保证棋盘对比度
    const L = (themeCfg() && themeCfg().light) || DEFAULT_LIGHT;
    const bg = tex("TX_Battleground_BG");
    g.fillStyle = L.bgBase || "#14161b";
    g.fillRect(0, 0, W, H);
    g.save();
    g.beginPath();
    g.rect(vp.x, vp.y, vp.width, vp.height);
    g.clip();
    if (texReady(bg)) {
      const scale = Math.max(vp.width / bg.naturalWidth, vp.height / bg.naturalHeight);
      const w = bg.naturalWidth * scale, h = bg.naturalHeight * scale;
      g.drawImage(bg, vp.x + (vp.width - w) / 2, vp.y + (vp.height - h) / 2, w, h);
    }
    {
      const vg = g.createLinearGradient(0, vp.y, 0, vp.y + vp.height);
      const v = L.vignette || DEFAULT_LIGHT.vignette;
      vg.addColorStop(0, v[0]);
      vg.addColorStop(0.45, v[1]);
      vg.addColorStop(1, v[2]);
      g.fillStyle = vg;
      g.fillRect(vp.x, vp.y, vp.width, vp.height);
    }
    g.restore();
    const renderZ = (x, y) => (isWall(x, y) ? 0.62 : heightAt(x, y));
    const tiles = [];
    for (let y = 0; y < MAP_H; y += 1) {
      for (let x = 0; x < MAP_W; x += 1) {
        const z = renderZ(x, y);
        tiles.push({ x, y, z, depth: cam.project(x, y, z).depth });
      }
    }
    tiles.sort((a, b) => b.depth - a.depth);
    for (const t of tiles) {
      paintTerrainTile(g, cam, t);
    }
    // 整体色温（地形层专用，随主题）：极低透明度暖/冷罩色统一场景光感（同样限于相机 viewport）
    if (L.colorTemp) {
      g.fillStyle = L.colorTemp;
      g.fillRect(vp.x, vp.y, vp.width, vp.height);
    }
  }

  // —— 非均质材质 + 局部破损（场景深化：同材质内部微变化 + 磨损贴片/边缘缺口）——
  // 逐格确定性哈希（生成脚本 的 tile_variation 同构复算，口径见 地图美术规范）：
  // tone>=0.25 = 非均质微变化覆盖格；wear<9 = 磨损贴片；9<=wear<14 = 边缘缺口；rot = 方位。
  // 只加色/贴片不改几何：格边界、接缝、碰撞（routable/isWall）语义不变，装饰仍只挂 =3 障碍格。
  function tileVariation(x, y) {
    const h = (Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263)) >>> 0;
    return { tone: (h & 1023) / 1023, wear: (h >>> 10) % 100, rot: (h >>> 20) & 3 };
  }
  // 地块四边形内双线性取点（磨损贴片/边缘缺口定位用）
  function quadPoint(quad, u, v) {
    const [a, b, c, d] = quad;
    return {
      x: (a.x + (b.x - a.x) * u) * (1 - v) + (d.x + (c.x - d.x) * u) * v,
      y: (a.y + (b.y - a.y) * u) * (1 - v) + (d.y + (c.y - d.y) * u) * v,
    };
  }

  // 装饰构件（箱子/沙袋/岩块/管道/晶石/护栏/圆木/油桶）：只摆在 =3 障碍·掩体格上，
  // 与「不可走 + 遮挡」语义一一对应；随 paintTerrainTile 进入地形层，遮挡层复用时同样成立。
  function drawDecorProp(g, cam, t, kind, C) {
    const v = tileVariation(t.x, t.y);
    // 同族构件微变化：体量/高矮微抖动（footprint 仍限单格）+ 磨损构件描边加深
    const jw = 0.92 + v.tone * 0.14, jh = 0.94 + v.tone * 0.12;
    const rim = v.wear < 9 ? "rgba(0,0,0,.58)" : "rgba(0,0,0,.45)";
    const P = (dx, dy, dz) => projPt(cam, t.x + dx * jw, t.y + dy * jw, t.z + dz * jh);
    const cx = cam.p[0], cy = cam.p[1];
    // 等距盒体：只画朝相机的两个侧面 + 顶面（与 drawTileSides 同构）
    const box = (sx, sy, z0, hz, top, side, rim) => {
      const t4 = [P(-sx, -sy, z0 + hz), P(sx, -sy, z0 + hz), P(sx, sy, z0 + hz), P(-sx, sy, z0 + hz)];
      const b4 = [P(-sx, -sy, z0), P(sx, -sy, z0), P(sx, sy, z0), P(-sx, sy, z0)];
      if (cy > t.y) drawQuad([t4[3], t4[2], b4[2], b4[3]], side, rim, 1, g);
      else drawQuad([t4[0], t4[1], b4[1], b4[0]], side, rim, 1, g);
      if (cx > t.x) drawQuad([t4[1], t4[2], b4[2], b4[1]], side, rim, 1, g);
      else drawQuad([t4[3], t4[0], b4[0], b4[3]], side, rim, 1, g);
      drawQuad(t4, top, rim, 1, g);
      return t4;
    };
    switch (kind) {
      case "crate": {
        const t4 = box(0.32, 0.32, 0, 0.5, C.primary, C.secondary, rim);
        drawEdge(g, t4[0], t4[2], "rgba(0,0,0,.30)", 1.2);   // 顶面木板缝
        drawEdge(g, t4[1], t4[3], "rgba(0,0,0,.30)", 1.2);
        break;
      }
      case "sandbag": {
        box(0.38, 0.3, 0, 0.22, C.secondary, C.dark, "rgba(0,0,0,.40)");
        box(0.32, 0.26, 0.22, 0.2, C.primary, C.secondary, "rgba(0,0,0,.40)");
        box(0.24, 0.2, 0.42, 0.18, C.secondary, C.dark, "rgba(0,0,0,.40)");
        break;
      }
      case "rock": {
        const t4 = box(0.36, 0.34, 0, 0.42, C.primary, C.dark, "rgba(0,0,0,.5)");
        // 棱面感：顶面折线
        drawEdge(g, t4[0], t4[2], "rgba(255,255,255,.10)", 1.2);
        box(0.18, 0.16, 0.42, 0.16, C.secondary, C.dark, "rgba(0,0,0,.5)");
        break;
      }
      case "log": {
        box(0.42, 0.16, 0, 0.26, C.secondary, C.dark, rim);
        box(0.42, 0.16, 0.26, 0.2, C.primary, C.secondary, rim);
        break;
      }
      case "pipe": {
        const t4 = box(0.42, 0.15, 0.12, 0.26, C.secondary, C.dark, rim);
        drawEdge(g, t4[0], t4[1], C.accent, 2);              // 管箍
        drawEdge(g, t4[3], t4[2], C.accent, 2);
        box(0.1, 0.1, 0, 0.14, C.primary, C.dark, rim);
        break;
      }
      case "barrier": {
        const t4 = box(0.42, 0.12, 0, 0.3, C.primary, C.secondary, rim);
        for (let i = -1; i <= 1; i += 1) drawEdge(g, P(i * 0.24 - 0.1, -0.12, 0.3), P(i * 0.24 + 0.1, 0.12, 0.3), C.accent, 2);  // 警示斜纹
        drawEdge(g, t4[0], t4[1], C.accent, 1.6);
        break;
      }
      case "barrel": {
        box(0.26, 0.26, 0, 0.52, C.secondary, C.primary, rim);
        box(0.28, 0.28, 0.24, 0.05, C.accent, C.dark, rim);
        break;
      }
      case "sakura_tree": {
        // 樱花树：树干 + 树冠
        const trunk = box(0.08, 0.08, 0, 0.6, "#8b6f47", "#6b5537", "rgba(0,0,0,.5)");
        // 粉色树冠（圆形）
        const crownCenter = P(0, 0, 0.8);
        const crownRadius = 0.4 * cam.project(t.x, t.y, 0).s;
        g.beginPath();
        g.arc(crownCenter.x, crownCenter.y, crownRadius, 0, Math.PI * 2);
        g.fillStyle = "#ffc0e0";
        g.fill();
        g.strokeStyle = "#ffb0d0";
        g.lineWidth = 2;
        g.stroke();
        break;
      }
      case "ink_mountain": {
        // 水墨山（远景）
        const peak = P(0, 0, 1.2);
        const base = [P(-0.4, -0.3, 0), P(0.4, -0.3, 0), P(0.3, 0.3, 0), P(-0.3, 0.3, 0)];
        // 山体渐变
        const gradient = g.createLinearGradient(base[0].x, base[0].y, peak.x, peak.y);
        gradient.addColorStop(0, "#c0c0c0");
        gradient.addColorStop(1, "#808080");
        drawQuad([base[0], base[1], peak, peak], gradient, "rgba(0,0,0,.6)", 2, g);
        drawQuad([base[1], base[2], peak, peak], "#a0a0a0", "rgba(0,0,0,.6)", 2, g);
        drawQuad([base[2], base[3], peak, peak], "#909090", "rgba(0,0,0,.6)", 2, g);
        break;
      }
      case "ink_tree": {
        // 水墨树（松树/竹子）
        box(0.06, 0.06, 0, 0.5, "#707070", "#505050", "rgba(0,0,0,.6)");
        // 树冠（三角形）
        const top = P(0, 0, 0.9);
        const left = P(-0.25, -0.15, 0.5);
        const right = P(0.25, -0.15, 0.5);
        g.beginPath();
        g.moveTo(top.x, top.y);
        g.lineTo(left.x, left.y);
        g.lineTo(right.x, right.y);
        g.closePath();
        g.fillStyle = "#606060";
        g.fill();
        g.strokeStyle = "rgba(0,0,0,.7)";
        g.lineWidth = 1.5;
        g.stroke();
        break;
      }
      case "tower": {
        // 塔楼（要塞）
        box(0.4, 0.4, 0, 0.8, C.primary, C.secondary, rim);
        box(0.35, 0.35, 0.8, 0.3, C.secondary, C.dark, rim);
        // 塔顶
        const top = P(0, 0, 1.2);
        const base = [P(-0.35, -0.35, 1.1), P(0.35, -0.35, 1.1), P(0.35, 0.35, 1.1), P(-0.35, 0.35, 1.1)];
        drawQuad([base[0], base[1], top, top], C.accent, rim, 1, g);
        drawQuad([base[1], base[2], top, top], C.primary, rim, 1, g);
        drawQuad([base[2], base[3], top, top], C.secondary, rim, 1, g);
        break;
      }
      case "crystal":
      default: {
        // 晶石簇：3 根发光线尖（主题强调色），仍限制在单格足迹内
        const spikes = [[-0.16, -0.1, 0.5], [0.14, 0.06, 0.36], [0.02, -0.2, 0.28]];
        for (const [dx, dy, hz] of spikes) {
          const base = [P(dx - 0.12, dy - 0.12, 0), P(dx + 0.12, dy - 0.12, 0), P(dx + 0.12, dy + 0.12, 0), P(dx - 0.12, dy + 0.12, 0)];
          const apex = P(dx, dy, hz);
          drawQuad([base[1], base[2], apex, apex], C.accent, null, 1, g);
          drawQuad([base[2], base[3], apex, apex], C.primary, null, 1, g);
          drawQuad([base[3], base[0], apex, apex], C.secondary, null, 1, g);
        }
        break;
      }
    }
  }

  // 单地块绘制（地形底图与前景遮挡层共用；含侧壁/贴图/倒角/接缝/主题装饰）
  function paintTerrainTile(g, cam, t) {
    {
      drawTileSides(cam, t.x, t.y, t.z, 0.5, g);
      const th = themeCfg();
      const mapId = currentMap().id;
      const mapTheme = window.MAP_THEMES && window.MAP_THEMES[mapId] ? window.MAP_THEMES[mapId] : null;
      const L = mapTheme ? mapTheme.light : ((th && th.light) || DEFAULT_LIGHT);
      const quad = PROJ.tileQuad(cam, t.x, t.y, t.z, 0.015);
      const vv = tileVariation(t.x, t.y);
      const alt = (vv.wear * 4 + vv.rot) % 100 < 20;
      
      let img, tint;
      const isHighPlatform = t.z > 0;
      
      if (isWall(t.x, t.y)) {
        img = tex("tile_wall_side");
        tint = L.wallTint;
      } else if (isHighPlatform) {
        // 高台：金属格栅材质（与地面明显区分）
        img = tex(alt ? "tile_platform_top2" : "tile_platform_top");
        tint = L.platformTint;
      } else if (isPath(t.x, t.y)) {
        img = tex("tile_ground_top2");
        tint = L.pathTint;
      } else {
        img = tex("tile_ground_top");
        tint = L.groundTint;
      }
      
      drawTexturedQuad(quad, img, tint, g);
      
      // 高台专属：格栅纹理覆盖层
      if (isHighPlatform && mapTheme) {
        const gridColor = mapTheme.style === 'metal' ? "rgba(180,200,230,0.10)" :
                         mapTheme.style === 'sand' ? "rgba(160,140,110,0.08)" :
                         "rgba(150,175,200,0.09)";
        drawQuad(quad, gridColor, null, 0, g);
        // 格栅线条
        const [a, b, c, d] = quad;
        g.save();
        g.strokeStyle = "rgba(255,255,255,0.06)";
        g.lineWidth = 0.6;
        g.setLineDash([2, 2]);
        const midY1 = {x: (a.x+b.x)/2, y: (a.y+b.y)/2};
        const midY2 = {x: (d.x+c.x)/2, y: (d.y+c.y)/2};
        g.beginPath(); g.moveTo(midY1.x, midY1.y); g.lineTo(midY2.x, midY2.y); g.stroke();
        const midX1 = {x: (a.x+d.x)/2, y: (a.y+d.y)/2};
        const midX2 = {x: (b.x+c.x)/2, y: (b.y+c.y)/2};
        g.beginPath(); g.moveTo(midX1.x, midX1.y); g.lineTo(midX2.x, midX2.y); g.stroke();
        g.restore();
      }
      // 落影层：高台/障碍投在低地上的影（层次=台面/台侧/顶边/台阶/落影），只加色不改几何
      if (t.z === 0) {
        const upZ = t.y > 0 ? (isWall(t.x, t.y - 1) ? 0.62 : heightAt(t.x, t.y - 1)) : 0;
        if (upZ > 0) {
          drawQuad([quadPoint(quad, 0, 0), quadPoint(quad, 1, 0), quadPoint(quad, 1, 0.28), quadPoint(quad, 0, 0.28)],
            "rgba(8,10,16,.20)", null, 1, g);
          drawQuad([quadPoint(quad, 0, 0.28), quadPoint(quad, 1, 0.28), quadPoint(quad, 1, 0.50), quadPoint(quad, 0, 0.50)],
            "rgba(8,10,16,.10)", null, 1, g);
        }
      }
      // 非均质微变化 + 局部破损（低对比、低密度：磨损贴片 ≈9% / 边缘缺口 ≈5%；不改碰撞语义）
      if (vv.tone >= 0.25) {
        const ja = (0.012 + vv.tone * 0.03).toFixed(3);
        drawQuad(quad, vv.rot & 1 ? `rgba(255,255,255,${ja})` : `rgba(0,0,0,${ja})`, null, 1, g);
      }
      if (vv.wear < 9) {
        // 磨损贴片：靠角的低对比斑块（同材质磨损，不做异色大块）
        const u0 = 0.16 + 0.30 * (vv.rot % 2), v0 = 0.46 + 0.18 * ((vv.rot >> 1) & 1);
        const p1 = quadPoint(quad, u0, v0), p2 = quadPoint(quad, u0 + 0.24, v0 - 0.05);
        const p3 = quadPoint(quad, u0 + 0.20, v0 + 0.16), p4 = quadPoint(quad, u0 - 0.04, v0 + 0.11);
        drawQuad([p1, p2, p3, p4], vv.rot & 1 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.07)", null, 1, g);
      } else if (vv.wear < 14) {
        // 边缘缺口：沿一条边的小三角啃口（辨识边界仍由倒角/接缝线承担）
        const tri = vv.rot === 0 ? [quadPoint(quad, 0.42, 0), quadPoint(quad, 0.58, 0), quadPoint(quad, 0.50, 0.13)]
          : vv.rot === 1 ? [quadPoint(quad, 1, 0.42), quadPoint(quad, 1, 0.58), quadPoint(quad, 0.87, 0.50)]
          : vv.rot === 2 ? [quadPoint(quad, 0.42, 1), quadPoint(quad, 0.58, 1), quadPoint(quad, 0.50, 0.87)]
          : [quadPoint(quad, 0, 0.42), quadPoint(quad, 0, 0.58), quadPoint(quad, 0.13, 0.50)];
        drawQuad([tri[0], tri[1], tri[2], tri[2]], "rgba(0,0,0,.24)", null, 1, g);
      }
      // 单格辨识：暗缝 + 上亮下暗倒角边（细线低对比，保持接缝清晰但不织网）
      const [a, b, c, d] = quad;
      drawEdge(g, a, b, t.z > 0 ? "rgba(255,255,255,.20)" : "rgba(255,255,255,.12)", 1.2);   // 上边缘受光（台面顶边更亮）
      drawEdge(g, a, d, "rgba(255,255,255,.07)", 1.2);   // 左边缘受光
      drawEdge(g, d, c, "rgba(0,0,0,.34)", 1.5);         // 下边缘背光
      drawEdge(g, b, c, "rgba(0,0,0,.26)", 1.5);         // 右边缘背光
      drawQuad(quad, null, "rgba(8,10,14,.38)", 1, g);   // 格间接缝
      // 主题装饰构件：仅 =3 障碍·掩体格（规则与视觉一一对应，不放通路/部署格）
      const dk = decorKindAt(t.x, t.y);
      if (dk) drawDecorProp(g, cam, t, dk, (th && th.decor) || DEFAULT_DECOR);
    }
  }

  // —— 前景遮挡层（B4）：更近的地块/高台侧壁重绘到单位层之上 ——
  // 深度 = cam.project.depth（与单位排序同源）；台后单位被前景侧壁正确部分遮挡，
  // 不靠整体透明或缩人物；点击拾取仍以世界坐标为准，遮挡层不拦截输入（canvas 本身 pointer-events:none）。
  function drawOcclusion(cam, view) {
    const g = occCtx;
    g.clearRect(0, 0, occCanvas.width, occCanvas.height);
    if (!view) return;
    const feet = view.units.map((u) => {
      const z = heightAt(Math.round(u.x), Math.round(u.y));
      const p = cam.project(u.x, u.y, z);
      return { x: p.x, y: p.y, s: p.s, depth: cam.project(u.x, u.y, 0).depth };
    });
    const renderZ = (x, y) => (isWall(x, y) ? 0.62 : heightAt(x, y));
    const tiles = [];
    for (let y = 0; y < MAP_H; y += 1) {
      for (let x = 0; x < MAP_W; x += 1) {
        const z = renderZ(x, y);
        const pr = cam.project(x, y, z);
        // 遮挡深度按地面深度（z=0）比较：抬高的台面不因“离相机近”而误遮台前单位
        tiles.push({ x, y, z, depth: cam.project(x, y, 0).depth, sx: pr.x, sy: pr.y, s: pr.s });
      }
    }
    tiles.sort((a, b) => b.depth - a.depth);
    for (const t of tiles) {
      // 遮挡体只有“高台/障碍体量”（z>0）：平地永远不遮单位身体（修：台下单位被平地误遮）
      if (!(t.z > 0)) continue;
      const quad = PROJ.tileQuad(cam, t.x, t.y, t.z, 0.015);
      let qMinX = Infinity, qMaxX = -Infinity, qMinY = Infinity, qMaxY = -Infinity;
      for (const p of quad) {
        qMinX = Math.min(qMinX, p.x); qMaxX = Math.max(qMaxX, p.x);
        qMinY = Math.min(qMinY, p.y); qMaxY = Math.max(qMaxY, p.y);
      }
      const occludes = feet.some((f) => {
        if (f.depth <= t.depth + 0.02) return false;          // 只遮“比自己更近”的体量
        const bCx = f.x, bCy = f.y - 0.62 * f.s;               // 单位身体矩形（脚底→头顶）
        const bW = 0.72 * f.s, bH = 0.78 * f.s;
        return bCx + bW > qMinX && bCx - bW < qMaxX
          && bCy + bH > qMinY && bCy - bH < qMaxY;
      });
      if (occludes) paintTerrainTile(g, cam, t);
    }
  }

  // 选中范围叠层：原作斜纹（sprite_attack_range）+ 白色选中地块轮廓
  // 四向变换（契约同式）：gx = sx + col·dx − row·dy；gy = sy + col·dy + row·dx——攻击/技能范围同源，
  // 选向中按候选朝向实时预览（不再按 team±x）。
  function renderSelectionTo(g, cam, sel, op, sx, sy) {
    const stripe = getStripePattern(g);
    // 未来预览（选向候选/路线草稿首段）：与当前真实范围分样式+短标识——绝不让一个范围暗示可打却实际打另一方向
    const fut = FACING.futureVec(sel);
    if (fut) {
      for (const cell of facingCells(sx, sy, fut, shownRange(sel, op))) {
        const x = cell.x, y = cell.y;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        const q = PROJ.tileQuad(cam, x, y, heightAt(x, y), 0.016);
        g.save();
        g.setLineDash([6, 4]);
        drawQuad(q, "rgba(232,180,0,.10)", "rgba(232,180,0,.8)", 1.5, g);
        g.restore();
      }
      const tip = cam.project(sx + fut.x, sy + fut.y, heightAt(sx, sy));
      g.save();
      g.font = "bold 11px Microsoft YaHei";
      g.fillStyle = "rgba(232,180,0,.95)";
      g.strokeStyle = "rgba(20,24,30,.85)"; g.lineWidth = 3;
      g.strokeText(fut.kind, tip.x - 12, tip.y - 10);
      g.fillText(fut.kind, tip.x - 12, tip.y - 10);
      g.restore();
    }
    const vec = FACING.currentVec(sel);   // 当前真实攻击/治疗范围（权威朝向=快照 facing）
    for (const cell of facingCells(sx, sy, vec, shownRange(sel, op))) {
        const x = cell.x, y = cell.y;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        const q = PROJ.tileQuad(cam, x, y, heightAt(x, y), 0.02);
        g.save();
        g.globalAlpha = 0.42;                       // 原作斜纹（sprite_attack_range）：场上常显（校准透明度，路线/部署区不吞范围）
        drawQuad(q, stripe, null, 1, g);
        g.restore();
        drawQuad(q, "rgba(56,132,208,.24)", "rgba(130,200,255,.9)", 1.8, g);
    }
    // 选中地块：原作白色轮廓
    drawQuad(PROJ.tileQuad(cam, sx, sy, heightAt(sx, sy), 0.02), null, "#ffffff", 3, g);
  }

  function draw() {
    const view = state.view;
    const cam = battleCam();
    const map = currentMap();
    // 缓存键：相机（地图/阵营/平移）+ 画布尺寸 + 贴图就绪签名
    const key = `${map.name}|${state.team}|${state.cameraPreset || "default"}|${cam.viewport ? JSON.stringify(cam.viewport) : ""}|${canvas.width}x${canvas.height}|${(state.pan && state.pan.x) || 0},${(state.pan && state.pan.y) || 0}|${texSig()}`;
    let g = cacheCanvasFor(terrainCache, key);
    if (g) renderTerrainTo(g, cam);
    ctx.drawImage(terrainCache.cv, 0, 0);

    // 部署区高亮（G1/G2/G3）：地面初始可部署格常驻合并描边；高台可放位随选中上下文高亮；F 下地落点/拖移落点
    const descendOptions = state.descendTarget ? descendTiles(selectedUnit()) : [];
    drawDeployZones(ctx, cam, key, descendOptions);

    if (view) {
      const gates = view.gates || { blue: [{ x: 0, y: 5.5 }], red: [{ x: 15, y: 5.5 }] };
      // 重影修复：相邻同阵营门格合并成**一座**门结构（单个标签、单一外框），
      // 避免两座门箱体互相穿插造成线条/投影重叠重影与标签叠字。
      for (const [team, list] of [["blue", gates.blue], ["red", gates.red]]) {
        const merged = mergeAdjacentGates(list || []);
        for (const grp of merged) drawGateGroup(grp, team, view.gateHp[team], cam);
      }
    }

    // 路线引导线改由 routeCanvas 叠层绘制（ROUTE.drawOverlay）——此处不再重复绘制，避免双重描边。
    if (state.cardDrag?.active && state.cardDrag.tile) {
      const tile = state.cardDrag.tile;
      drawQuad(PROJ.tileQuad(cam, tile.x, tile.y, heightAt(tile.x, tile.y), .02), state.cardDrag.valid ? "rgba(80,210,160,.25)" : "rgba(240,70,60,.25)", state.cardDrag.valid ? "#8dffd5" : "#ff776b", 3);
    }

    const sel = view && view.units.find((u) => u.id === state.selectedUnitId);
    if (sel) {
      const op = operator(sel.opId);
      const sx = Math.round(sel.x), sy = Math.round(sel.y);
      const selVec = FACING.vectorFor(sel);   // 四向朝向参与缓存键：选向候选变化即重绘范围斜纹
      const futVec = FACING.futureVec(sel);
      g = cacheCanvasFor(overlayCache, `${key}|${sel.id}|${sx},${sy}|${selVec.x},${selVec.y}|fut:${futVec ? `${futVec.x},${futVec.y},${futVec.kind}` : ""}|${JSON.stringify(shownRange(sel, op))}`);
      if (g) renderSelectionTo(g, cam, sel, op, sx, sy);
      ctx.drawImage(overlayCache.cv, 0, 0);
    }

    // 无 Spine 模型的单位用轻量占位兜底（模型加载后由单位层绘制并即刻替换）
    if (view) {
      const order = view.units.slice().sort((a, b) => cam.project(b.x, b.y, 0).depth - cam.project(a.x, a.y, 0).depth);
      for (const unit of order) drawUnitShadow(unit, cam);
      for (const unit of order) {
        if (spineLayer.has(unit.id)) { drawUnitHpBar(unit, cam); continue; }
        drawUnitCard(unit, cam);
      }
      
      // 召唤物渲染（矢量占位符）
      if (view.summons && view.summons.length > 0) {
        const summonOrder = view.summons.slice().sort((a, b) => 
          cam.project(b.x, b.y, 0).depth - cam.project(a.x, a.y, 0).depth
        );
        for (const summon of summonOrder) {
          drawSummon(summon, cam);
        }
      }
      
      drawFacingArrows(ctx, cam, view);
      drawSkillMarkers(view, cam);
    }

    if (view && view.winner) {
      ctx.fillStyle = "rgba(240,240,240,.78)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = view.winner === state.team ? "#232323" : "#d8443c";
      ctx.font = "bold 56px Microsoft YaHei";
      ctx.textAlign = "center";
      ctx.fillText(view.winner === state.team ? "OPERATION SUCCESS" : "OPERATION FAILED", canvas.width / 2, canvas.height / 2 - 10);
      ctx.font = "22px Microsoft YaHei";
      ctx.fillText(view.winner === state.team ? "敌方蓝门攻破 · 作战胜利" : "己方蓝门陷落 · 作战失败", canvas.width / 2, canvas.height / 2 + 34);
      ctx.textAlign = "left";
    }
  }

  // 门/出生点：原作式透视立体框（蓝门=实线半透明，红门=红色线框+警示三角）
  // —— 门结构合并（重影修复）——
  // 原作里"一个门"常占相邻两格（如 training 的 red(11,3)+(11,4)）。逐格各画一座门箱体会互相穿插，
  // 产生用户反馈的"线条/投影重叠重影 + 标签叠字"。此处把上下/左右相邻的同阵营门格并成一组，
  // 按组的**包围盒中心**画一座门（单个外框 + 单个标签），保持门血与命中格不变。
  function mergeAdjacentGates(list) {
    const cells = (list || []).filter((g) => g && Number.isFinite(g.x) && Number.isFinite(g.y));
    const groups = [];
    const seen = new Set();
    for (const c of cells) {
      const k = `${c.x},${c.y}`;
      if (seen.has(k)) continue;
      // BFS 收集与当前格 4-邻接相连的同阵营门格
      const grp = [];
      const q = [c];
      seen.add(k);
      while (q.length) {
        const cur = q.shift();
        grp.push(cur);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nk = `${cur.x + dx},${cur.y + dy}`;
          if (seen.has(nk)) continue;
          const hit = cells.find((t) => t.x === cur.x + dx && t.y === cur.y + dy);
          if (hit) { seen.add(nk); q.push(hit); }
        }
      }
      groups.push(grp);
    }
    return groups;
  }

  // 画一组门（可能含相邻多格）：外框覆盖整组包围盒，标签只有一个，门血来自阵营权威值
  function drawGateGroup(group, team, hp, cam) {
    if (!group.length) return;
    const xs = group.map((g) => g.x), ys = group.map((g) => g.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2 + 0.5;
    // 组的外接半宽/半高（格数越多门体越长；单格时与原尺寸一致，不改变单门图）
    const halfX = (Math.max(...xs) - Math.min(...xs)) / 2 + 0.62;
    const halfY = (Math.max(...ys) - Math.min(...ys)) / 2 + 0.62;
    const spanY = (Math.max(...ys) - Math.min(...ys)) + 1;
    const spanX = (Math.max(...xs) - Math.min(...xs)) + 1;
    drawGateShape(cx, cy, team, hp, cam, halfX, halfY, spanX, spanY);
  }

  function drawGateShape(cxTile, cyTile, team, hp, cam, halfX, halfY, spanX, spanY) {
    const x = cxTile, y = cyTile;
    const z = heightAt(Math.round(x), Math.round(y));
    const h = 1.15;                     // 门体高度（原先 1.75 过高，视觉上像悬空方箱；压低成"闸门"）
    const col = team === "blue" ? "#4fb4ff" : "#ef5a4c";
    const corners = [];
    for (const dz of [z, z + h]) {
      corners.push(
        cam.project(x - halfX, y - halfY, dz), cam.project(x + halfX, y - halfY, dz),
        cam.project(x + halfX, y + halfY, dz), cam.project(x - halfX, y + halfY, dz),
      );
    }
    const [b0, b1, b2, b3, t0, t1, t2, t3] = corners;
    const edge = (p, q) => { ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); };
    ctx.save();
    // 地面落影：更紧凑，避免超出门体范围
    ctx.fillStyle = "rgba(0,0,0,.25)";
    ctx.beginPath();
    // 内缩10%，避免阴影过大
    const shadowInset = 0.1;
    const sb0 = { x: b0.x + (b1.x - b0.x) * shadowInset + (b3.x - b0.x) * shadowInset, y: b0.y + (b1.y - b0.y) * shadowInset + (b3.y - b0.y) * shadowInset };
    const sb1 = { x: b1.x + (b0.x - b1.x) * shadowInset + (b2.x - b1.x) * shadowInset, y: b1.y + (b0.y - b1.y) * shadowInset + (b2.y - b1.y) * shadowInset };
    const sb2 = { x: b2.x + (b3.x - b2.x) * shadowInset + (b1.x - b2.x) * shadowInset, y: b2.y + (b3.y - b2.y) * shadowInset + (b1.y - b2.y) * shadowInset };
    const sb3 = { x: b3.x + (b2.x - b3.x) * shadowInset + (b0.x - b3.x) * shadowInset, y: b3.y + (b2.y - b3.y) * shadowInset + (b0.y - b3.y) * shadowInset };
    [sb0, sb1, sb2, sb3].forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();

    const faces = [];
    if (cam.p[1] < y) faces.push([t0, t1, b1, b0]);
    if (cam.p[0] > x) faces.push([t1, t2, b2, b1]);
    if (cam.p[1] > y) faces.push([t2, t3, b3, b2]);
    if (cam.p[0] < x) faces.push([t3, t0, b0, b3]);
    // 可见面：单层半透明填充（不再叠两层，避免"重影"观感）
    ctx.fillStyle = team === "blue" ? "rgba(56,150,235,.20)" : "rgba(226,72,60,.16)";
    for (const f of faces) {
      ctx.beginPath();
      f.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    }
    // 门体：用"闸门"造型替代裸线框方箱（用户反馈线框内部出现意义不明的交叉线）。
    // 正面 = 半透明面板 + 粗边框；顶面 = 高光条；底部 = 贴地暗影。所有内部装饰都贴合面，
    // 不再让栅栏线穿过正面，保证任何相机角度下都不出现乱线。
    const front = faces.length ? faces[0] : [t0, t1, b1, b0];
    ctx.fillStyle = team === "blue" ? "rgba(56,150,235,.22)" : "rgba(226,72,60,.18)";
    ctx.beginPath();
    front.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = col;
    ctx.stroke();
    // 正面竖向条纹（栅栏感，限制在正面内部，只画短竖线不连线）
    ctx.save();
    ctx.beginPath();
    front.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 2;
    const nBar = Math.max(spanX, spanY) * 2;
    for (let i = 1; i < nBar; i += 1) {
      const f = i / nBar;
      const a = { x: front[0].x + (front[3].x - front[0].x) * f, y: front[0].y + (front[3].y - front[0].y) * f };
      const b = { x: front[1].x + (front[2].x - front[1].x) * f, y: front[1].y + (front[2].y - front[1].y) * f };
      edge(a, b);
    }
    ctx.restore();
    // 顶面高光条（金属反光感）
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = team === "blue" ? "rgba(190,230,255,.95)" : "rgba(255,205,195,.95)";
    ctx.beginPath();
    [t0, t1, t2, t3].forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    // 顶面与正面的分界线（让立体感成立，但不产生交叉线）
    ctx.lineWidth = 2;
    ctx.strokeStyle = col;
    edge(t0, t1);
    edge(t1, t2);
    // 底边强化「贴地」
    ctx.globalAlpha = 0.65;
    ctx.lineWidth = 2.5;
    for (const [p, q] of [[b0, b1], [b1, b2], [b2, b3], [b3, b0]]) edge(p, q);
    ctx.globalAlpha = 1;
    // 门面内侧装饰：一小段内嵌高光框（替代原先穿过门面的三角形——那正是用户看到的"意义不明的线"）。
    // 用内缩矩形而不是三角，任何相机角度都不会与外框交叉。
    if (team !== "blue") {
      const fc = front;
      const ix = (fc[0].x + fc[1].x + fc[2].x + fc[3].x) / 4;
      const iy = (fc[0].y + fc[1].y + fc[2].y + fc[3].y) / 4;
      const iw = Math.max(10, 0.16 * t0.s), ih = Math.max(8, 0.20 * t0.s);
      ctx.strokeStyle = "rgba(255,190,180,.75)";
      ctx.lineWidth = 2;
      ctx.strokeRect(ix - iw, iy - ih, iw * 2, ih * 2);
    }
    // 门血标签：整组一个，压在门体正上方（不叠字）
    const top = { x: (t0.x + t1.x + t2.x + t3.x) / 4, y: Math.min(t0.y, t1.y, t2.y, t3.y) };
    ctx.font = `bold ${Math.max(13, 0.25 * t0.s)}px Microsoft YaHei`;
    ctx.textAlign = "center";
    const label = `${team === "blue" ? "蓝门" : "红门"} ${hp}`;
    const tw = ctx.measureText(label).width;
    const bh = 0.40 * t0.s + 8;
    ctx.fillStyle = "rgba(14,16,22,.82)";
    drawRounded(top.x - tw / 2 - 10, top.y - bh - 4, tw + 20, bh, 5);
    ctx.fill();
    ctx.strokeStyle = team === "blue" ? "rgba(120,200,255,.55)" : "rgba(255,150,140,.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = team === "blue" ? "#9fdcff" : "#ffb3aa";
    ctx.fillText(label, top.x, top.y - bh - 4 + bh * 0.72);
    ctx.restore();
    ctx.textAlign = "left";
  }

  function drawGate(x, y, team, hp, cam) {
    drawGateShape(x, y, team, hp, cam, 0.62, 0.62, 1, 1);
  }

  // ---------------- 战斗特效层（原作贴图：入场圈/受击闪光/飘字/弹道 + 脚影/血条） ----------------
  // 补制特效清单/来源见 特效清单。事件驱动：HP/技能状态跃迁触发一次，同一伤害事件不重播。
  // 叠层自愈：styles.css 未给 #fxCanvas 叠层规则时它随文本流落到棋盘下方（屏外）；这里在运行时
  // 补齐与 #unitCanvas 一致的绝对定位（不改 styles.css/index.html），特效层恒在单位层之上。
  // pointer-events:none —— 不拦截棋盘点击/技能按钮（输入绑定语义不变）。
  (function overlayFxCanvas() {
    fxCanvas.style.position = "absolute";
    fxCanvas.style.left = "0";
    fxCanvas.style.top = "0";
    fxCanvas.style.width = "100%";
    fxCanvas.style.height = "100%";
    fxCanvas.style.display = "block";
    fxCanvas.style.pointerEvents = "none";
  })();
  const fxState = {
    floats: [], slashes: [], shots: [], bolts: [], blooms: [],
    pulses: [], rings: [], casts: [], hits: [], flash: null, bubbles: [],
    deaths: [],
  };
  // drawFx 自计时（毫秒级预算断言用；探针经 __FX_DEBUG__.cost 读取，热帧只累加标量）
  const fxPerf = { sum: 0, n: 0, max: 0 };
  const hpPrev = new Map();
  const shieldFxPrev = new Map();
  const skillFxPrev = new Map();
  // 离场事件分流（快照 exits.reason 消费即清）：breach=突入敌门=返回手牌 → 进门光效/淡出（绝非死亡特效）；
  // death=阵亡消散；retreat/skillExit=收势淡出（轻）。
  const exitReason = new Map();
  // 飞行/滞空判定（技能期起飞：跃空锤等 leap 形技能 + 快照显式 airborne/hover 标记）：
  // 空中单位的受击/死亡不带坠地感（无地面冲击环/尘），改用气流/漂浮粒子；[ASSUMED] 快照暂无恒定飞行标记，
  // 常驻飞行单位出现后以 u.airborne/u.hover 为准，动作组 takeoff/levitate 落地后此判定自动失效。
  function unitAirborne(u) {
    if (u.airborne === true || (u.hover || 0) > 0) return true;
    if (!u.skillActive) return false;
    const op = operator(u.opId);
    const sk = (op.skills && op.skills[u.skillIndex || 0]) || op.skill;
    const sig = SKILL_FX_NAME[sk && sk.name] || (sk && sk.fx) || null;
    return !!(sig && sig.shape === "leap");
  }
  const PROJ_TEX = {
    kroos: "projectile_arrow_new", exusiai: "projectile_crossbow_new", ash: "projectile_crossbow_new",
    eyjafjalla: "projectile_yuki", amiya: "projectile_yuki", suzuran: "projectile_yuki",
    ifrit: "img_fx_light_02", lappland: "img_fx_light_01", silverash: "img_fx_light_01",
  };
  // 阵营色体系统一：我方（蓝方）= 青蓝冷调、敌方（红方）= 红橙暖调；形状按职业/技能签名区分。
  // 重做口径（§FX-STYLE）：阵营是"底色倾向"，不是"唯一色"——职业色必须仍是该特效的主导色相，
  // 否则近卫/狙击/术师全被染成同一片青或橙，"区分度不够"。故阵营融色收窄（红 0.34/蓝 0.12，见 fxTintFor）。
  const FX_ACCENT = { blue: "#5ce0ff", red: "#ff7a33" };
  // 职业色系（一眼可辨施法者职业）：近卫红橙/狙击金/医疗绿/术师紫蓝/重装青灰/先锋橙/辅助青/特种品红。
  // 重做：色相间距拉开（红 18°/金 46°/绿 118°/紫 268°/青 196°/橙 28°/品红 328°），避免"近卫与先锋都是橙"、
  // "重装与辅助都是青"。饱和度为原值上提（sRGB 空间不再二次降饱和）。
  const FX_CLASS = { 近卫: "#ff5a2e", 狙击: "#ffc61a", 医疗: "#3dff7a", 术师: "#a45cff", 重装: "#7fa8c4", 先锋: "#ff8c1a", 辅助: "#2fd8ff", 特种: "#ff4fb0" };
  // 近战斩击：白弧 + 职业/阵营热色火星；"斩击弧光"形状本身即语言，故弧体保持高亮近白、热色走火星与冲击星。
  const FX_MELEE = {
    blue: { arc: "#f2fbff", hot: "#5ce0ff", spark: "#a8ecff" },
    red: { arc: "#fff6ec", hot: "#ff7a33", spark: "#ffb27a" },
  };
  // 治疗=绿金（绿主金辅，与一切伤害特效互异：伤害走红/橙/紫/白，治疗独有的绿金双色是硬口径）
  const FX_HEAL = { blue: "#3dff7a", red: "#ffc61a" };
  const FX_HEAL_GOLD = "#ffdf7a";
  // 逐职业施法前摇（ms，补制·借鉴 Stronghold units.js 姿态节奏）：前摇段画聚能线，主形状在前摇后展开。
  // 术师/辅助抬手吟唱更久，医疗举杖居中，近卫/特种/狙击出手更快，重装沉稳。
  const FX_CAST_WINDUP = { 术师: 300, 医疗: 240, 辅助: 260, 狙击: 130, 近卫: 150, 重装: 180, 先锋: 130, 特种: 150 };
  // 受击冲击星：口径=白闪冲击星 + 阵营语言。我方被打→近白冷星 + 警示红边（一眼"我在掉血"）；
  // 敌方被打→敌方暖色（红橙）。故 blue 侧必须近白（不能再是饱和青，否则"我方受击"读成青色）。
  const FX_HIT = { blue: "#eaf6ff", red: "#ff9a4d" };
  // 咏唱圈 sigil（施法者脚下）：按职业分形，开局一眼可辨"谁在放大招"——圆形/三角/方/菱/六边/星/双弧
  // 借鉴 Stronghold fx/simfx.js 'charge' 的"地环 + 旋转刻度"节奏，形状语言改为逐职业分化。
  const FX_SIGIL = { 近卫: 3, 狙击: 4, 医疗: 6, 术师: 6, 重装: 5, 先锋: 4, 辅助: 6, 特种: 3 };
  function hexRgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  // 技能签名基础色 → 阵营色调（蓝方偏冷 18%、红方偏暖 50%）；事件入列时解析一次（绘制零开销）
  // 技能签名基础色 → 阵营色调（重做：蓝方偏冷 12%、红方偏暖 34%）。
  // 旧值 50% 把红方一切技能染成同一片橙（近卫红橙/先锋橙/狙击金三者在屏幕上不可分），本轮收窄以保职业色相。
  function fxClassBlend(base, role) {
    const cls = FX_CLASS[role];
    if (!cls) return base;
    const a = hexRgb(base), b = hexRgb(cls);
    const c0 = Math.round(a[0] + (b[0] - a[0]) * 0.45), c1 = Math.round(a[1] + (b[1] - a[1]) * 0.45), c2 = Math.round(a[2] + (b[2] - a[2]) * 0.45);
    return `#${c0.toString(16).padStart(2, "0")}${c1.toString(16).padStart(2, "0")}${c2.toString(16).padStart(2, "0")}`;
  }
  function fxTintFor(base, team) {
    const accent = team === "red" ? FX_ACCENT.red : FX_ACCENT.blue;
    const k = team === "red" ? 0.34 : 0.12;
    const a = hexRgb(base), b = hexRgb(accent);
    const c0 = Math.round(a[0] + (b[0] - a[0]) * k), c1 = Math.round(a[1] + (b[1] - a[1]) * k), c2 = Math.round(a[2] + (b[2] - a[2]) * k);
    return `#${c0.toString(16).padStart(2, "0")}${c1.toString(16).padStart(2, "0")}${c2.toString(16).padStart(2, "0")}`;
  }
  // reduceFx 偏好：只查询一次 DOM（缓存元素），高频路径不再查表
  let fxReduceEl;
  function fxReduced() {
    if (fxReduceEl === undefined) fxReduceEl = document.getElementById("cfgReduceFx") || null;
    return !!(fxReduceEl && fxReduceEl.checked);
  }
  // 职业/技能差异化特效：原作贴图优先（弹道/阴影/范围），难提取的技能特效按职业特征补制。
  // 形状/轨迹/速度节奏/命中反馈/颜色互异：术师=紫青辉光球+环爆、医疗=绿色十字升腾、狙击=原作弹体直速、
  // 近战=白弧斩、辅助/特种=青色脉冲环。法术与治疗视觉不同源。事件驱动，重复快照不重播。
  function fxKindOf(op, isHeal) {
    if (isHeal) return "heal";
    switch (op.role) {
      case "术师": return "arts";
      case "狙击": return "sniper";
      case "医疗": return "heal";
      case "辅助":
      case "特种": return "control";
      default: return "melee";
    }
  }
  // 逐技能签名表现（补制）：全技能按语义关键词生成（同名技能跨干员共用签名）。
  // 取用优先级：SKILL_FX_NAME 手工签名 > 数据侧 skill.fx（全技能覆盖）> effect 族默认（skillFxByName）。
  // 字段：shape 签名形状 / color 基础色（入列时按阵营融色）/ dur 节奏时长 ms / heavy 重击（屏闪白 + 预警圈）。
  // 未列技能按 effect 族默认（见 skillFxByName）；缺项清单见 特效清单。
  // 形状库补制借鉴 Stronghold fx/kinds.js FX_KINDS + fx/simfx.js 的表现模式：
  // leap（takeoff/lift+slam：起跳光条+落地冲击）/ reticle（lock 瞄准环）/ shatter（shieldBreak 碎裂）
  // / telegraph（telegraph 预警圈）/ nova（blast）/ wave（wave 脉冲）/ cross（heal）/ coins（dp）等，
  // 均为程序化补制（官方 skill 特效在粒子预制体里，未随 skel 提取）。
  const SKILL_FX_NAME = {
    // 先锋
    "支援号令·β型": { shape: "coins", color: "#ffd24a", dur: 900 },
    "治愈之翼": { shape: "cross", color: "#7dff9b", dur: 800 },
    "冲锋号令·γ型": { shape: "coins", color: "#ffd24a", dur: 800 },
    "剑雨": { shape: "rain", color: "#8fd6ff", dur: 1000 },
    "跃空锤": { shape: "leap", color: "#cfe0ff", dur: 850, heavy: true },
    "碎颅击": { shape: "slam", color: "#ffe0a8", dur: 650, heavy: true },
    // 近卫/重装（本作近卫位含重装干员）
    "急救": { shape: "cross", color: "#7dff9b", dur: 650 },
    "药物配置": { shape: "cross", color: "#a8ffcf", dur: 800 },
    "钙质化": { shape: "ring", color: "#c9ff8f", dur: 1100 },
    "防御力强化·β型": { shape: "shield", color: "#a8d8ff", dur: 800 },
    "壳状防御": { shape: "shield", color: "#82d4e8", dur: 1000 },
    "战意": { shape: "chevrons", color: "#ffd24a", dur: 800 },
    "荆棘": { shape: "spikes", color: "#9de1a7", dur: 800 },
    "力之锯": { shape: "saw", color: "#bfe9ff", dur: 1100 },
    "攻击力强化·α型": { shape: "chevrons", color: "#ffb2c0", dur: 700 },
    "日晷": { shape: "orbit", color: "#c9d8ff", dur: 1100 },
    "狼魂": { shape: "fangs", color: "#b2c8ff", dur: 800 },
    "强力击·γ型": { shape: "reticle", color: "#d2e4ff", dur: 800 },
    "雪境生存法则": { shape: "ring", color: "#cfeaff", dur: 1000 },
    "真银斩": { shape: "wave", color: "#e8f2ff", dur: 700, heavy: true },
    "攻击力强化·γ型": { shape: "chevrons", color: "#9ce6d4", dur: 800 },
    "护身尖刺": { shape: "spikes", color: "#9ce6d4", dur: 800 },
    "至高之术": { shape: "chevrons", color: "#ffd24a", dur: 900 },
    "防御力强化·γ型": { shape: "shield", color: "#d4c7a3", dur: 800 },
    "岩崩锤": { shape: "slam", color: "#ffcf9a", dur: 700, heavy: true },
    "秽壤的血脉": { shape: "nova", color: "#ff6b4a", dur: 900, heavy: true },
    // 狙击
    "二连射·自动": { shape: "fan", color: "#c9e08f", dur: 650 },
    "冲锋模式": { shape: "charge", color: "#ffd58a", dur: 800 },
    "扫射模式": { shape: "fan", color: "#ffd58a", dur: 750 },
    "过载模式": { shape: "chevrons", color: "#ffe9a8", dur: 800 },
    "支援射击": { shape: "fan", color: "#f2c59b", dur: 700 },
    "突击战术": { shape: "charge", color: "#f2c59b", dur: 750 },
    "攻坚榴弹": { shape: "slam", color: "#ffb27a", dur: 700, heavy: true },
    // 术师
    "战术咏唱·γ型": { shape: "charge", color: "#c7a4ff", dur: 800 },
    "精神爆发": { shape: "fan", color: "#b96bff", dur: 750 },
    "奇美拉": { shape: "nova", color: "#b96bff", dur: 900, heavy: true },
    "二重咏唱": { shape: "charge", color: "#ffb0a0", dur: 800 },
    "点燃": { shape: "ember", color: "#ff8a3c", dur: 900 },
    "火山": { shape: "pillar", color: "#ff8a3c", dur: 1000, heavy: true },
    "狂热": { shape: "chevrons", color: "#ff8c83", dur: 800 },
    "炎爆": { shape: "nova", color: "#ff7a3c", dur: 800, heavy: true },
    "灼地": { shape: "scorch", color: "#ff8a3c", dur: 1100 },
    // 医疗
    "治疗强化·γ型": { shape: "cross", color: "#7dff9b", dur: 800 },
    "脑啡肽": { shape: "cross", color: "#a8ffd8", dur: 900 },
    "信条": { shape: "chevrons", color: "#ffd24a", dur: 800 },
    "自动掩护": { shape: "shield", color: "#ffe7b0", dur: 800 },
    "教条力场": { shape: "cross", color: "#a8ffcf", dur: 1000 },
    // 辅助
    "全力以赴": { shape: "ring", color: "#6fe7ff", dur: 1000 },
    "儿时的舞乐": { shape: "orbit", color: "#a8e8ff", dur: 1100 },
    "狐火渺然": { shape: "ring", color: "#6fe7ff", dur: 1100 },
  };
  function skillFxByName(name, effect, color) {
    // effect 族 → 签名形状（同干员不同技能按语义分化：伤害/治疗/套泡/给费/控制各不同源）。
    // 映射借鉴 Stronghold fx/kinds.js FX_KINDS 的 archetype 归类（heal→heal、shield→shield、
    // buff→buff、aoe→blast、multishot→volley、counter→counter、true_burst→blast·heavy…）。
    const shape = effect === "heal" ? "cross"
      : effect === "cost" ? "coins"
      : effect === "def" || effect === "shield" ? "shield"
      : effect === "shield_ally" ? "bubble"
      : effect === "slow" ? "ring"
      : effect === "buff" || effect === "next_attack" ? "chevrons"
      : effect === "counter" ? "spikes"
      : effect === "true_burst" ? "nova"
      : effect === "burst" ? "nova"
      : effect === "spin" ? "wave"
      : effect === "multishot" ? "fan"
      : effect === "support" ? "coins"
      : effect === "aoe" ? "ring"
      : "ring";
    return SKILL_FX_NAME[name] || {
      shape,
      color: color || "#9fd8ff",
      dur: 1000,
    };
  }

  // 命中反馈入列：弹体到达时刻的火花+环爆（事件时刻预定，不靠逐帧状态机重播）
  function fxFlashAt(t, now) {
    // 屏幕轻微闪白：仅重击，且 450ms 冷却（连段重击不连闪）；设置“降低特效”关闭
    if (fxReduced()) return;
    if (fxState.flash && t <= fxState.flash.until + 450) return;
    fxState.flash = { t: Math.max(t, now), until: Math.max(t, now) + 150 };
  }
  function scheduleHit(x, y, t, team, heavy, opt) {
    fxState.hits.push({ x, y, t, team, heavy, air: !!(opt && opt.air), vteam: (opt && opt.vteam) || null, life: heavy ? 440 : 300 });
    if (heavy) fxFlashAt(t, performance.now());
  }

  function feedEffects(view) {
    const now = performance.now();
    if (!view) { hpPrev.clear(); skillFxPrev.clear(); return; }
    const seen = new Set();
    for (const u of view.units) {
      seen.add(u.id);
      // 技能发动（状态跃迁一次性触发；重复快照不重播）
      const prevActive = skillFxPrev.get(u.id);
      if (prevActive === false && u.skillActive) {
        const op = operator(u.opId);
        const sk = (op.skills && op.skills[u.skillIndex || 0]) || op.skill;
        // 逐技能签名：SKILL_FX_NAME 手工签名 > 数据侧 skill.fx（全技能覆盖）> effect 族默认
        const sig = SKILL_FX_NAME[sk && sk.name] || (sk && sk.fx) || skillFxByName(sk && sk.name, sk && sk.effect, op.color);
        // 逐职业姿态节奏（借鉴 Stronghold units.js 按职业选演出 + fx/simfx.js wind-up 节奏）：
        // 术师/辅助抬手吟唱更久（先聚能后绽放），医疗举杖居中，近卫/特种/狙击出手更快
        fxState.casts.push({
          x: u.x, y: u.y, t: now, team: u.team, life: (sig.dur || 1100) + 40,
          role: op.role,   // 职业徽记（FX_SIGIL）与纯职业色环用；不改技能签名自身色相
          fx: {
            shape: sig.shape, color: fxTintFor(fxClassBlend(sig.color, op.role), u.team), dur: sig.dur || 1100,
            // clr：纯职业色（阵营微调）——施法前摇的咏唱环/徽记/释放波用它，保证"谁在放技能"一眼可辨，
            // 而签名形状仍用融合色（保留技能自身语义色，如点燃的火橙、奇美拉的紫）。
            clr: fxTintFor(FX_CLASS[op.role] || sig.color, u.team),
            heavy: !!sig.heavy, windup: FX_CAST_WINDUP[op.role] ?? 140, effect: sk && sk.effect,
          },
        });
        if (sig.heavy) fxFlashAt(now, now);
      }
      skillFxPrev.set(u.id, !!u.skillActive);
      // 护盾变化（泡/屏障）→ 泡泡特效（区别于治疗十字/法术球；事件驱动不重播）
      const prevShield = shieldFxPrev.get(u.id);
      if (prevShield !== undefined && (u.shield || 0) > prevShield) {
        fxState.bubbles.push({ x: u.x, y: u.y, t: now, team: u.team });
      }
      // 护盾击碎反馈（借鉴 Stronghold fx/kinds.js shieldBreak→shatter）：归零瞬间碎裂闪光，仅一次
      if (prevShield !== undefined && prevShield > 0 && (u.shield || 0) <= 0) {
        fxState.casts.push({
          x: u.x, y: u.y, t: now, team: u.team, life: 520,
          fx: { shape: "shatter", color: fxTintFor("#dfe8ff", u.team), dur: 520, heavy: false, windup: 0 },
        });
      }
      shieldFxPrev.set(u.id, u.shield || 0);
      const rec = hpPrev.get(u.id);
      const air = unitAirborne(u);
      if (rec === undefined) {
        fxState.rings.push({ x: u.x, y: u.y, t: now, team: u.team });    // 入场（原作方向环展开）
        hpPrev.set(u.id, { hp: u.hp, x: u.x, y: u.y, team: u.team, air });
      } else {
        const prev = rec.hp;
        rec.x = u.x; rec.y = u.y; rec.team = u.team; rec.air = air;
        if (u.hp !== prev) {
        const delta = u.hp - prev;
        // team = 受击/受治疗方阵营（飘字配色用：我方受击=警示红、敌方受击=敌方色、治疗=绿金）
        fxState.floats.push({ x: u.x, y: u.y, t: now, text: `${delta > 0 ? "+" : ""}${Math.round(delta)}`, heal: delta > 0, team: u.team });
        if (delta > 0) {
          fxState.blooms.push({ x: u.x, y: u.y, t: now, team: u.team }); // 治疗：十字升腾（区别于法术）
        } else {
          // 重击判定：掉血 ≥ max(90, 8% 上限) → 火花/环爆加大 + 轻闪白（reduceFx 关闭屏闪）
          const heavy = -delta >= Math.max(90, u.maxHp * 0.08);
          let src = null, bestD = 4.2 * 4.2;
          for (const a of view.units) {
            if (a.team === u.team) continue;
            const dx = a.x - u.x, dy = a.y - u.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= bestD) { bestD = d2; src = a; }
          }
          if (src) {
            const kind = fxKindOf(operator(src.opId), false);
            const sop = operator(src.opId);
            // clr：射手职业色（阵营微调）——弹道/弧光"谁打的"一眼可辨（狙击金/术师紫/近卫红橙/辅助青…）
            const common = { from: { x: src.x, y: src.y }, to: { x: u.x, y: u.y }, t: now, kind, team: src.team, vteam: u.team,
              clr: fxTintFor(FX_CLASS[sop.role] || sop.color || "#9fd8ff", src.team) };
            const dist = Math.sqrt(bestD);
            const hitOpt = { air, vteam: u.team };
            if (kind === "sniper") {
              const travel = Math.min(460, Math.max(170, dist * 55));   // 恒速弹道：时长随距离
              fxState.shots.push({ ...common, tex: PROJ_TEX[src.opId] || "projectile_arrow_new", travel, life: travel + 180 });
              scheduleHit(u.x, u.y, now + travel, src.team, heavy, hitOpt);
            } else if (kind === "arts") {
              const travel = Math.min(620, Math.max(280, dist * 85));   // 法术稍慢 + 抛物弧线
              fxState.bolts.push({ ...common, color: fxTintFor(op.color || "#b96bff", src.team), travel, life: travel + 220 });
              scheduleHit(u.x, u.y, now + travel, src.team, heavy, hitOpt);
            } else if (kind === "control") {
              fxState.pulses.push({ x: u.x, y: u.y, t: now, team: src.team, air, clr: common.clr });
              scheduleHit(u.x, u.y, now + 200, src.team, heavy, hitOpt);
            } else {
              // 近战命中：弧光沿 攻击者→受击者 方向展开；combo 相位让多段/连击残影错拍（不叠加糊脸）
              fxState.slashes.push({ x: u.x, y: u.y, from: { x: src.x, y: src.y }, t: now, team: src.team, heavy, air, clr: common.clr, combo: (fxState.slashes.length + fxState.hits.length) % 3 });
              scheduleHit(u.x, u.y, now + 70, src.team, heavy, hitOpt);
            }
          }
        }
      }
        rec.hp = u.hp;
      }
    }
    // 离场一次性反馈（位置取最后已知坐标；事件驱动不重播）：按 exits.reason 分流——
    // breach=突入敌门（返回手牌）→ 进门光效/淡出（无死亡消散）；death=阵亡消散；retreat/skillExit=收势淡出
    if (view.exits && view.exits.length) {
      for (const ex of view.exits) {
        if (ex && ex.id != null) exitReason.set(String(ex.id), ex.reason || "death");
      }
      if (exitReason.size > 64) exitReason.clear();   // 防御性上限（消费即清，正常远小于此）
    }
    for (const id of hpPrev.keys()) {
      if (seen.has(id)) continue;
      const gone = hpPrev.get(id);
      const reason = exitReason.get(String(id)) || "death";
      exitReason.delete(String(id));
      // breach：向敌方门方向吸入光（team=离场方；其进攻的门=对方阵营门）
      let to = null;
      if (reason === "breach" && view.gates) {
        const gl = view.gates[gone.team === "blue" ? "red" : "blue"] || [];
        if (gl.length) {
          let best = null, bestD = Infinity;
          for (const g of gl) {
            const d2 = (g.x - gone.x) ** 2 + (g.y - gone.y) ** 2;
            if (d2 < bestD) { bestD = d2; best = g; }
          }
          if (best) to = { x: best.x, y: best.y };
        }
      }
      fxState.deaths.push({
        x: gone.x, y: gone.y, t: now, team: gone.team,
        kind: reason === "breach" ? "breach" : reason === "death" ? "death" : "retreat",
        air: gone.air, to,
      });
      hpPrev.delete(id);
      skillFxPrev.delete(id);
    }
    // 就地压缩（不逐帧分配新数组）；life 优先于族默认存续时长
    for (const key of FX_LIFE_KEYS) {
      const arr = fxState[key];
      const maxAge = FX_LIFE[key];
      let w = 0;
      for (let i = 0; i < arr.length; i += 1) {
        const e = arr[i];
        if (now - e.t < (e.life || maxAge)) arr[w++] = e;
      }
      arr.length = w;
    }
    if (fxState.flash && now > fxState.flash.until) fxState.flash = null;
  }
  const FX_LIFE = {
    floats: 1400, slashes: 340, blooms: 800, pulses: 550, bolts: 900,
    shots: 700, rings: 520, casts: 1400, hits: 460, deaths: 720, bubbles: 900,
  };
  const FX_LIFE_KEYS = Object.keys(FX_LIFE);

  function drawUnitShadow(unit, cam) {
    const z = heightAt(Math.round(unit.x), Math.round(unit.y));
    const foot = cam.project(unit.x, unit.y, z);
    const sh = hudTex("sprite_box_shadow");
    const w = 1.05 * foot.s, h = 0.42 * foot.s;
    if (texReady(sh)) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.drawImage(sh, foot.x - w / 2, foot.y - h / 2, w, h);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, 0.36 * foot.s, 0.13 * foot.s, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(10,14,20,.35)";
      ctx.fill();
    }
  }

  // 脚下 SP / 技能持续条（用户要求：每名干员脚下实时 SP 条；技能发动后改为随真实剩余时间递减的橙条，
  // 结束恢复 SP 条。瞬发=不画持续条（立即结束）；动作型/永久=无限持续（画满不倒数，不伪造 5 秒）；
  // 回费/被动技不画（无 SP 语义）。所有比例均来自快照真实字段，不做本地假计时。）
  function drawUnitHpBar(unit, cam) {
    const z = heightAt(Math.round(unit.x), Math.round(unit.y));
    const foot = cam.project(unit.x, unit.y, z);
    const s = foot.s;
    const bw = 0.78 * s, bh = Math.max(3, 0.075 * s);
    const y = foot.y + 0.10 * s;
    ctx.fillStyle = "rgba(8,10,14,.62)";
    ctx.fillRect(foot.x - bw / 2 - 1, y - 1, bw + 2, bh + 2);
    const ratio = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
    ctx.fillStyle = unit.team === "blue" ? "#4fd66e" : "#ff6b5e";
    ctx.fillRect(foot.x - bw / 2, y, bw * ratio, bh);

    const op = operator(unit.opId);
    const carried = carriedSkill(unit);
    const trigger = (SKILL_CONTROLS[carried && carried.id] || {}).trigger;
    // 被动技无 SP 语义：不画条（不是隐藏效果，而是该干员本来就没有技力条）
    const isPassive = !op || !carried || trigger === "PASSIVE";
    if (isPassive) return;

    const sh = Math.max(3, 0.045 * s), sy = y + bh + 3;
    ctx.fillStyle = "rgba(8,10,14,.8)";
    ctx.fillRect(foot.x - bw / 2 - 1, sy - 1, bw + 2, sh + 2);

    if (unit.skillActive) {
      // —— 技能生效中：橙色持续条按真实剩余时间递减 ——
      const total = Number(unit.skillDurTotal) > 0 ? unit.skillDurTotal : 0;
      const left = unit.skillDurLeft;                       // null = 无限持续（动作型/永久）
      const infinite = left === null || left === undefined || !(total > 0);
      const k = infinite ? 1 : Math.max(0, Math.min(1, left / total));
      ctx.fillStyle = "#ff8a1e";
      ctx.fillRect(foot.x - bw / 2, sy, bw * k, sh);
      // 描边让橙条与 HP 条一眼可分（形状+颜色双重区分，不只换色）
      ctx.strokeStyle = "rgba(255,196,120,.95)";
      ctx.lineWidth = 1;
      ctx.strokeRect(foot.x - bw / 2 - 0.5, sy - 0.5, bw + 1, sh + 1);
      return;
    }
    // —— 非生效中：SP 条（就绪=青绿满格，未满=青绿按比例）——
    const spk = Math.max(0, Math.min(1, unit.sp / Math.max(1, unit.spCost)));
    ctx.fillStyle = unit.sp >= unit.spCost ? "#d9ff65" : "#67dba7";
    ctx.fillRect(foot.x - bw / 2, sy, bw * spk, sh);
  }

  // 特效画布：职业/技能差异化表现（叠在单位层之上）
  // 性能：径向渐变按 (族, 颜色, 半径档) 缓存复用（fxGlowFill 用 translate 定位），热帧零梯度/数组/闭包分配。
  const fxGradCache = new Map();
  function fxGlowFill(fx, family, color, x, y, r, alpha) {
    const rb = Math.max(8, Math.ceil(r / 8) * 8);
    const ck = `${family}|${color}|${rb}`;
    let g = fxGradCache.get(ck);
    if (!g) {
      const [cr, cg, cb] = hexRgb(color);
      g = fx.createRadialGradient(0, 0, 0, 0, 0, rb);
      if (family === "orb") {
        g.addColorStop(0, "#ffffff");
        g.addColorStop(0.35, color);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      } else if (family === "nova") {
        g.addColorStop(0, color);
        g.addColorStop(1, "rgba(20,0,30,0)");
      } else if (family === "soft") {
        g.addColorStop(0, `rgba(${cr},${cg},${cb},0.8)`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      } else {
        g.addColorStop(0, color);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      }
      if (fxGradCache.size > 128) fxGradCache.clear();   // 防御性上限
      fxGradCache.set(ck, g);
    }
    fx.save();
    fx.globalAlpha = alpha;
    fx.fillStyle = g;
    fx.fillRect(x - rb, y - rb, rb * 2, rb * 2);
    fx.restore();
  }
  function fxAt(cam, x, y) {
    return cam.project(x, y, heightAt(Math.round(x), Math.round(y)));
  }
  // ---------------- 特效绘制原语（光晕/粒子/闪光共用基础函数；逐特效只写形状参数） ----------------
  // 混合模式口径：发光层 lighter（亮核+彩色光晕叠加）、实体层 source-over（暗边描/烟尘/碎片）。
  // 时长口径：单元素 120~320ms 快进慢出（8%~12% 进场 + easeOut 收束）；组合演出（治疗升腾/死亡消散/破门收束）
  // 由多段短元素拼接（总长 ≤600ms），逐元素归零不留残影。亮芯下的 FX_EDGE 暗边描是暗色 UI 上的对比衬边。
  const FX_EDGE = "rgba(8,11,17,.55)";
  const fxEaseOut = (k) => 1 - (1 - k) * (1 - k) * (1 - k);
  const fxHash = (i, seed) => {
    const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // —— 共用描边核心（三合一，合并原 fxRing/fxArc/fxBeam 的重复段落）——
  // 一次路径、三次 stroke：① source-over 暗边描（暗 UI 上的对比衬边）② lighter 彩色主体 ③ lighter 白芯细描。
  // 三者只差"路径怎么建"，故把路径构建抽成回调，描边口径只有这一处（改配色/对比度只改这里）。
  function fxStroke3(fx, color, alpha, w, build, core) {
    if (alpha <= 0.015) return;
    fx.save();
    fx.lineWidth = w;
    fx.beginPath();
    build(fx);
    fx.globalCompositeOperation = "source-over";
    fx.globalAlpha = alpha * 0.5;
    fx.strokeStyle = FX_EDGE;
    fx.stroke();
    fx.globalCompositeOperation = "lighter";
    fx.globalAlpha = Math.min(1, alpha);
    fx.strokeStyle = color;
    fx.stroke();
    if (core !== false) {
      fx.globalAlpha = Math.min(1, alpha * 0.9);
      fx.lineWidth = Math.max(1, w * 0.38);
      fx.strokeStyle = "#ffffff";
      fx.stroke();
    }
    fx.restore();
  }
  // 椭圆环（暗边描→色环→白芯细环）
  function fxRing(fx, x, y, rx, ry, w, color, alpha, core) {
    if (rx <= 0 || ry <= 0) return;
    fxStroke3(fx, color, alpha, w, (g) => g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2), core);
  }
  // 弧线（斩击弧/旋锯/双牙/箭羽共用）
  function fxArc(fx, x, y, r, a0, a1, w, color, alpha, core) {
    if (r <= 0) return;
    fxStroke3(fx, color, alpha, w, (g) => g.arc(x, y, r, a0, a1), core);
  }
  // 直线（弹道尾迹/光柱/箭羽/棘刺共用）
  function fxBeam(fx, x0, y0, x1, y1, w, color, alpha, core) {
    fxStroke3(fx, color, alpha, w, (g) => { g.moveTo(x0, y0); g.lineTo(x1, y1); }, core);
  }
  // 多边形描边（护盾六边/瞄准六边/碎片环共用；三描边同上，闭合路径）
  function fxPoly(fx, x, y, r, ry, n, rot, w, color, alpha, core) {
    if (r <= 0 || n < 3) return;
    fxStroke3(fx, color, alpha, w, (g) => {
      for (let k = 0; k < n; k += 1) {
        const a = (Math.PI * 2 * k) / n + rot;
        const xx = x + Math.cos(a) * r, yy = y + Math.sin(a) * ry;
        k === 0 ? g.moveTo(xx, yy) : g.lineTo(xx, yy);
      }
      g.closePath();
    }, core);
  }
  // 冲击星/十字闪光（白芯 + 色光角，lighter）：受击冲击帧/暴击顿帧/斩击弧尖共用。
  // 重做：外圈色角加"暗边"衬底（source-over）——亮芯在亮地形上不再糊掉；白核占比 0.26→0.32 且不再随 alpha 衰减，
  // 保证"命中瞬间跳出来"（关键帧亮核）。
  function fxFlare(fx, x, y, r, color, alpha, points, rot) {
    if (alpha <= 0.015 || r <= 0) return;
    const n = points || 4;
    fx.save();
    fx.translate(x, y);
    // 暗边衬底：先画一圈略大的近黑角，再叠彩色角（对比度提升，亮底图上也立得住）
    fx.globalCompositeOperation = "source-over";
    fx.globalAlpha = Math.min(0.55, alpha * 0.6);
    fx.fillStyle = FX_EDGE;
    for (let k = 0; k < n; k += 1) {
      const a = (Math.PI * 2 * k) / n + (rot || 0);
      const c = Math.cos(a), s = Math.sin(a);
      fx.beginPath();
      fx.moveTo(-s * r * 0.24, c * r * 0.24);
      fx.lineTo(c * r * 1.14, s * r * 1.14);
      fx.lineTo(s * r * 0.24, -c * r * 0.24);
      fx.closePath();
      fx.fill();
    }
    fx.globalCompositeOperation = "lighter";
    fx.fillStyle = color;
    fx.globalAlpha = Math.min(1, alpha);
    for (let k = 0; k < n; k += 1) {
      const a = (Math.PI * 2 * k) / n + (rot || 0);
      const c = Math.cos(a), s = Math.sin(a);
      fx.beginPath();
      fx.moveTo(-s * r * 0.16, c * r * 0.16);
      fx.lineTo(c * r, s * r);
      fx.lineTo(s * r * 0.16, -c * r * 0.16);
      fx.closePath();
      fx.fill();
    }
    // 白核：始终保底 0.4 亮度的白心（冲击帧"顿"感来源）；末段才收
    fx.globalAlpha = Math.max(0.4, Math.min(1, alpha));
    fx.fillStyle = "#ffffff";
    fx.beginPath();
    fx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
    fx.fill();
    fx.restore();
  }
  // 冲击帧合成（受击/斩击落点/弹道命中共用同一套"白闪+色光晕+冲击环+火花"）：
  // 合并原 hits 循环与 slashes 落点的重复段落，逐特效只传尺寸/颜色/形态参数。
  // air=true → 胸口小环（空中单位不带坠地感）；ground=true → 地面扩散椭圆环。
  function fxSpark(fx, x, y, s, color, alpha, opt) {
    const o = opt || {};
    const scale = o.scale || 1;
    const base = s * scale;
    // 白闪冲击帧（高频亮段）+ 亮核光晕
    fxFlare(fx, x, y, base * 0.95, color, alpha * (o.star || 0.95), o.points || 4, o.rot || 0.35);
    fxGlowFill(fx, "orb", "#ffffff", x, y, base * 0.75, alpha * 0.5);
    const ringA = Math.max(0, 1 - (o.age || 0));
    if (o.air) {
      fxRing(fx, x, y, base * (0.35 + (o.age || 0) * 0.7), base * (0.2 + (o.age || 0) * 0.4), Math.max(2, 0.05 * s), color, ringA * 0.7);
    } else if (o.ground !== false) {
      const gy = y + (o.groundDrop != null ? o.groundDrop : 0.34) * s;
      fxRing(fx, x, gy, base * (0.42 + (o.age || 0) * 1.35), base * (0.17 + (o.age || 0) * 0.55), Math.max(2, 0.055 * s), color, ringA * 0.85);
    }
    // 火花溅射（lighter）
    fxMotes(fx, x, y, base, color, alpha * 0.95, o.motes || 7, o.seed || 3.7, o.age || 0, "out", 0.06 * s, o.blend);
  }
  // 无状态粒子群：位置由 (i, seed, age) 哈希决定（零分配、确定性、age→1 即归零不残留）
  // mode："up" 升腾 / "out" 迸溅 / "in" 收束；blend 传 "source-over" 画烟尘（默认 lighter 发光）
  function fxMotes(fx, x, y, r, color, alpha, n, seed, age, mode, size, blend) {
    if (alpha <= 0.015 || age < 0 || age >= 1) return;
    fx.save();
    fx.globalCompositeOperation = blend || "lighter";
    fx.fillStyle = color;
    for (let i = 0; i < n; i += 1) {
      const h1 = fxHash(i, seed), h2 = fxHash(i + 17.3, seed), h3 = fxHash(i + 41.7, seed);
      const a = h1 * Math.PI * 2;
      let px, py;
      if (mode === "up") {
        px = x + Math.cos(a) * r * (0.2 + h2 * 0.8) + Math.sin(age * 6 + h3 * 9) * r * 0.16;
        py = y - age * r * (1.1 + h3 * 1.3) - h2 * r * 0.35;
      } else if (mode === "in") {
        const d = r * (1 - age) * (0.6 + h2 * 0.7);
        px = x + Math.cos(a) * d;
        py = y + Math.sin(a) * d * 0.55;
      } else {
        const d = r * (0.25 + age * (0.85 + h2 * 0.95));
        px = x + Math.cos(a) * d;
        py = y + Math.sin(a) * d * 0.6 + age * r * 0.22 * (h3 - 0.35);
      }
      const s = (size || 0.05) * (1 - age * 0.55) * (0.6 + h2 * 0.9);
      fx.globalAlpha = Math.min(1, alpha) * (1 - age) * (0.5 + h3 * 0.5);
      fx.beginPath();
      fx.arc(px, py, Math.max(0.6, s), 0, Math.PI * 2);
      fx.fill();
    }
    fx.restore();
  }
  function drawFx(fx, cam) {
    const now = performance.now();
    const t0 = now;
    
    // ⚡ 性能优化：清理过期特效（战斗越久越卡的主因修复）
    // 每帧清理 age>1.05 的死特效，防止数组无限增长
    const FX_KEYS = ['slashes', 'shots', 'bolts', 'blooms', 'pulses', 'rings', 'casts', 'hits', 'floats', 'bubbles', 'deaths'];
    for (const key of FX_KEYS) {
      const arr = fxState[key];
      if (!Array.isArray(arr)) continue;
      // 倒序遍历避免splice后索引错乱
      for (let i = arr.length - 1; i >= 0; i--) {
        const item = arr[i];
        if (!item || !item.t) continue;
        const life = item.life || (key === 'slashes' ? (item.heavy ? 320 : 240) : 
                                   key === 'shots' ? 900 : 
                                   key === 'floats' ? 1400 : 1000);
        const age = (now - item.t) / life;
        if (age > 1.05) {  // 留5%余量，防止最后一帧被提前删除
          arr.splice(i, 1);
        }
      }
    }
    
    // 特效数量上限保护（防止激烈战斗时性能崩溃）
    const totalFx = FX_KEYS.reduce((sum, k) => sum + (fxState[k]?.length || 0), 0);
    if (totalFx > 120) {
      // 超过上限，优先丢弃飘字（视觉影响最小）
      if (fxState.floats.length > 10) fxState.floats.splice(0, Math.min(20, fxState.floats.length - 10));
      // 仍超限则丢弃最老的hits
      if (totalFx > 100 && fxState.hits.length > 5) fxState.hits.splice(0, 5);
    }
    
    // ① 斩击弧光（普攻·近战）：定向新月弧（暗边描+色弧+白芯）沿 攻击者→受击者 扫过 + 冲击星 + 火花溅射。
    // impact scale pop：8% 进场后 0.86→1.18 快展、末段 easeOut 收干净；240ms（重击 320ms）。胸口高度不糊脸。
    for (const s of fxState.slashes) {
      const dur = s.heavy ? 320 : 240;
      const age = (now - s.t) / dur;
      if (age < 0 || age > 1) continue;
      const p = fxAt(cam, s.x, s.y);
      const base = FX_MELEE[s.team] || FX_MELEE.blue;
      // 职业色优先（"谁打的"一眼可辨）：热色/火星取 attackers 职业色，弧体仍近白（斩击语言）
      const pal = s.clr ? { arc: base.arc, hot: s.clr, spark: s.clr } : base;
      const k = fxEaseOut(Math.min(1, age * 1.25));
      const alpha = age < 0.08 ? age / 0.08 : Math.max(0, 1 - (age - 0.08) / 0.92);
      // impact scale pop（重做）：弧光首帧大 12% 再回落（0.78→1.24 展开），落点冲击帧同步放大
      const pop = age < 0.14 ? 1.12 - (age / 0.14) * 0.12 : 1;
      const r = (s.heavy ? 1.18 : 0.94) * p.s * (0.86 + k * 0.32) * pop;
      const cx = p.x, cy = p.y - 0.48 * p.s;
      let ang = -0.45;
      if (s.from) {
        const a0 = fxAt(cam, s.from.x, s.from.y);
        ang = Math.atan2(cy - a0.y, cx - a0.x);
      }
      ang += ((s.combo || 0) - 1) * 0.3;   // 连击/多段残影：相位错拍，不叠糊
      const tipX = cx + Math.cos(ang) * r * 0.82, tipY = cy + Math.sin(ang) * r * 0.82;
      fxGlowFill(fx, "soft", pal.hot, (cx + tipX) / 2, (cy + tipY) / 2, r * 1.05, alpha * 0.55);
      // 新月实体弧：source-over 暗边衬底 + lighter 色弧（实体感 vs 发光分层）。
      // 重做·形状语言：弧带更"薄而锐"（张角 1.15→1.32 但内缘差 0.58→0.72），一眼是"斩"不是"一团光"。
      fx.save();
      fx.globalCompositeOperation = "source-over";
      fx.globalAlpha = alpha * 0.6;
      fx.fillStyle = FX_EDGE;
      fx.beginPath();
      fx.arc(cx, cy, r, ang - 1.32, ang + 1.32);
      fx.arc(cx, cy, r * 0.72, ang + 0.86, ang - 0.86, true);
      fx.closePath();
      fx.fill();
      fx.globalCompositeOperation = "lighter";
      fx.globalAlpha = Math.min(1, alpha * 0.88);
      fx.fillStyle = pal.arc;
      fx.fill();
      fx.restore();
      // 刃口亮线（外缘细弧，白芯占比提高）+ 内缘热色细弧（斩击"厚度"）
      fxArc(fx, cx, cy, r * 0.94, ang - 1.18, ang + 1.18, Math.max(2.5, 0.055 * p.s), pal.arc, alpha, true);
      fxArc(fx, cx, cy, r * 0.78, ang - 1.0, ang + 1.0, Math.max(2, 0.038 * p.s), pal.hot, alpha * 0.7, false);
      // 冲击帧：弧尖白闪星 + 火花溅射（末段归零，不残留）——共用 fxSpark 的冲击星/粒子段
      fxFlare(fx, tipX, tipY, (s.heavy ? 0.6 : 0.46) * p.s * (1.25 - k * 0.45) * pop, pal.hot, alpha * 0.95, s.heavy ? 6 : 4, ang);
      fxMotes(fx, tipX, tipY, 0.6 * p.s, pal.spark, alpha * 0.95, s.heavy ? 9 : 6, 7.3 + (s.combo || 0), age, "out", 0.05 * p.s);
    }
    // ② 法术弹道（术师）：紫青辉光球 + 抛物弧线 + 锥形拖尾 + 逸散粒子（命中迸发见 hits）
    for (const b of fxState.bolts) {
      const age = (now - b.t) / b.travel;
      if (age < 0 || age > 1.02) continue;
      const a = fxAt(cam, b.from.x, b.from.y), c = fxAt(cam, b.to.x, b.to.y);
      const lift = (0.22 + 0.33 * Math.min(1, Math.hypot(c.x - a.x, c.y - a.y) / (8 * a.s))) * a.s;
      const px = a.x + (c.x - a.x) * age, py = a.y + (c.y - a.y) * age - Math.sin(age * Math.PI) * lift;
      const rad = Math.max(8, 0.18 * a.s);
      // 锥形拖尾：4 段递减宽/透明（暗边→色→白芯），先线后球的层次
      for (let seg = 1; seg <= 4; seg += 1) {
        const t0 = Math.max(0, age - seg * 0.075), t1 = Math.max(0, age - (seg - 1) * 0.075);
        if (t1 <= 0) continue;
        const x0 = a.x + (c.x - a.x) * t0, y0 = a.y + (c.y - a.y) * t0 - Math.sin(t0 * Math.PI) * lift;
        const x1 = a.x + (c.x - a.x) * t1, y1 = a.y + (c.y - a.y) * t1 - Math.sin(t1 * Math.PI) * lift;
        fxBeam(fx, x0, y0, x1, y1, Math.max(1.5, 0.055 * a.s) * (1 - seg * 0.18), b.color, (1 - age) * 0.55 * (1 - seg * 0.15), seg === 1);
      }
      // 辉光头：白芯 + 色光晕（lighter）；白核加大（0.42→0.5）让"弹道"在混战中不丢
      fxGlowFill(fx, "orb", b.color, px, py, rad * 2.1, Math.max(0, 1 - age * 0.35));
      fx.save();
      fx.globalCompositeOperation = "lighter";
      fx.globalAlpha = Math.max(0, 1 - age * 0.5);
      fx.fillStyle = "#ffffff";
      fx.beginPath();
      fx.arc(px, py, rad * 0.5, 0, Math.PI * 2);
      fx.fill();
      fx.restore();
      // 逸散粒子（确定性；沿轨迹外飘）
      fxMotes(fx, px, py, rad * 1.6, b.color, 0.6, 3, 3.1 + b.t, age, "out", 0.045 * a.s);
    }
    // ③ 狙击弹道：原作弹体贴图 + 恒速直线 + 锥形速度线（170~460ms；命中迸发见 hits）
    for (const s of fxState.shots) {
      const age = (now - s.t) / s.travel;
      if (age < 0 || age > 1.02) continue;
      const a = fxAt(cam, s.from.x, s.from.y), b = fxAt(cam, s.to.x, s.to.y);
      const px = a.x + (b.x - a.x) * age, py = a.y + (b.y - a.y) * age;
      const img = hudTex(s.tex);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      // 弹道色走**射手职业色**（狙击金等），命中星才走受击方阵营色：轨迹"谁在打" + 落点"谁挨打"两段可分
      const pal = s.clr || FX_HIT[s.team] || FX_HIT.blue;
      // 锥形尾迹：两段递减宽（暗边→色→白芯）
      for (let k = 1; k <= 2; k += 1) {
        const t1 = Math.max(0, age - k * 0.085);
        if (t1 <= 0) continue;
        fxBeam(fx, a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1, px, py,
          Math.max(1.5, 0.05 * a.s) * (1 - k * 0.35), pal, 0.55 / k, k === 1);
      }
      // 弹头：辉光 + 原作弹体贴图（source-over 实体贴图压在发光上）
      fxGlowFill(fx, "orb", pal, px, py, 0.2 * a.s, 0.5);
      fx.save();
      fx.globalAlpha = 1;
      fx.translate(px, py);
      fx.rotate(ang);
      if (texReady(img)) {
        const w = 0.55 * a.s, h = w * (img.naturalHeight / img.naturalWidth);
        fx.drawImage(img, -w / 2, -h / 2, w, h);
      } else {
        fx.fillStyle = "#ffe9a8";   // 弹体贴图未就绪的占位
        fx.fillRect(-8, -2, 16, 4);
      }
      fx.restore();
    }
    // ④ 命中迸发（弹体到达时刻由 feedEffects 预定）：白闪冲击星 + 冲击环 + 火花溅射（共用 fxSpark）。
    // 重做·明显度：首帧 pop 1.4→1.62、尺寸 0.56/0.78→0.72/0.96、白核不随 alpha 归零（顿帧感）；
    // 重做·颜色：命中星走"受击方阵营色"（FX_HIT[vteam 侧]），我方受击再叠警示红边 → 一眼分辨谁挨打。
    // 重击叠双环/暗烟/大星（暴击破甲感）。240ms（重击 320ms）快收不残留。
    for (const h of fxState.hits) {
      const dur = h.heavy ? 320 : 240;
      const age = (now - h.t) / dur;
      if (age < 0 || age > 1) continue;
      const p = fxAt(cam, h.x, h.y);
      const hy = p.y - 0.42 * p.s;
      const mine = h.vteam && h.vteam === state.team;                 // 我方单位挨打（vteam=受击方）
      const vteam = h.vteam || (h.team === "red" ? "blue" : "red");   // 受击方阵营（决定特效色）
      const pal = FX_HIT[vteam] || FX_HIT.blue;
      const pop = age < 0.16 ? 1.62 - (age / 0.16) * 0.62 : 1;        // impact scale pop：首帧更大、快回落
      const base = (h.heavy ? 0.96 : 0.72) * p.s * pop;
      const starA = Math.max(0, 1 - age * 2.4);
      // 冲击帧合成：白闪冲击星 + 白核光晕 + 冲击环（空中→胸口小环）+ 火花溅射
      fxSpark(fx, p.x, hy, p.s, pal, starA, {
        scale: (h.heavy ? 0.96 : 0.72) * pop, age, air: h.air, points: h.heavy ? 6 : 4,
        motes: h.heavy ? 12 : 8, seed: 3.7 + h.x + h.y, rot: 0.35,
      });
      const ringA = Math.max(0, 1 - age);
      if (h.heavy) {
        fxRing(fx, p.x, hy + 0.34 * p.s, base * (0.2 + age * 1.9), base * (0.08 + age * 0.8), Math.max(2, 0.04 * p.s), "#ffffff", ringA * 0.6);
        fxMotes(fx, p.x, hy + 0.1 * p.s, base * 0.8, "#242a35", 0.42, 5, 9.1 + h.x, age, "out", 0.09 * p.s, "source-over");
        fxGlowFill(fx, "soft", pal, p.x, hy, base * 1.25, ringA * 0.5);
      }
      // 我方受击：警示红边（红环 + 红色暗边描，与敌方受击的阵营色星一眼可辨）
      if (mine) {
        fxRing(fx, p.x, p.y - 0.55 * p.s, 0.56 * p.s, 0.86 * p.s, Math.max(3, 0.07 * p.s), "#ff3b3b", Math.max(0, 1 - age * 1.5) * 0.95);
        fxFlare(fx, p.x, p.y - 0.5 * p.s, 0.3 * p.s * (1 - age * 0.6), "#ff5252", Math.max(0, 1 - age * 2) * 0.8, 4, 0.79);
      }
    }
    // ⑤ 控制/辅助脉冲：双层扩散环 + 浮光粒子（青/橙阵营色；320ms 快收）
    for (const s of fxState.pulses) {
      const age = (now - s.t) / 320;
      if (age < 0 || age > 1) continue;
      const p = fxAt(cam, s.x, s.y);
      // 控制/辅助脉冲走施法者职业色（辅助青/特种品红…），无职业色时回退阵营色
      const col = s.clr || (s.team === "red" ? FX_ACCENT.red : FX_ACCENT.blue);
      const k = fxEaseOut(age);
      fxRing(fx, p.x, p.y, (0.32 + k * 1.45) * p.s, (0.15 + k * 0.64) * p.s, Math.max(2, 0.06 * p.s), col, (1 - age) * 0.95);
      fxRing(fx, p.x, p.y, (0.2 + k * 0.95) * p.s, (0.09 + k * 0.42) * p.s, Math.max(1.5, 0.04 * p.s), "#ffffff", (1 - age) * 0.6, false);
      fxMotes(fx, p.x, p.y - 0.3 * p.s, 0.62 * p.s, col, 0.68, 7, 6.6 + s.x, age, "up", 0.045 * p.s);
    }
    // ⑥ 治疗光柱（绿金上飘）：柔光柱 + 金芯 + 双层上飘粒子 + 十字柔光 + 脚下绿晕环——
    // 形状/颜色语言与一切伤害特效互异（绿→金，无冲击星/无环爆/无暗烟）。
    // 重做·明显度：光柱加"实体亮芯柱"（白芯直柱，不是只有柔光）+ 十字加大 + 金芯上描边，
    // 在深色与浅色地形上都能一眼看出"这里在奶人"。
    for (const s of fxState.blooms) {
      const age = (now - s.t) / 520;
      if (age < 0 || age > 1) continue;
      const p = fxAt(cam, s.x, s.y);
      const col = FX_HEAL[s.team] || FX_HEAL.blue;
      const gold = FX_HEAL_GOLD;
      const y0 = p.y - 0.15 * p.s;
      const fade = Math.max(0, 1 - age);
      // 绿金光柱：三层柔光叠柱（lighter）+ 白芯实柱 + 金芯
      fxGlowFill(fx, "soft", col, p.x, y0 - 0.35 * p.s, 0.62 * p.s, fade * 0.6);
      fxGlowFill(fx, "soft", col, p.x, y0 - 0.85 * p.s, 0.5 * p.s, fade * 0.5);
      fxGlowFill(fx, "soft", gold, p.x, y0 - 0.55 * p.s, 0.3 * p.s, fade * 0.55);
      // 光柱实心亮芯（绿→白→金三段竖柱；"光柱"而非"光团"的关键）
      fxBeam(fx, p.x, y0, p.x, y0 - (0.9 + age * 0.5) * p.s, Math.max(3, 0.1 * p.s), col, fade * 0.85, true);
      fxBeam(fx, p.x, y0 - 0.05 * p.s, p.x, y0 - (0.6 + age * 0.4) * p.s, Math.max(2, 0.05 * p.s), gold, fade * 0.9, true);
      // 上飘粒子（绿→金双层）+ 十字柔光（白芯绿晕，缓缓升起）
      fxMotes(fx, p.x, y0 - 0.5 * p.s, 0.55 * p.s, col, 0.9, 9, 11.3, age, "up", 0.052 * p.s);
      fxMotes(fx, p.x, y0 - 0.9 * p.s, 0.36 * p.s, gold, 0.8, 5, 5.1, age, "up", 0.04 * p.s);
      const cy2 = y0 - (0.85 + age * 0.55) * p.s;
      const size = Math.max(11, 0.3 * p.s) * (1 - age * 0.3);
      fxBeam(fx, p.x, cy2 - size, p.x, cy2 + size, size * 0.5, col, fade * 0.95, true);
      fxBeam(fx, p.x - size, cy2, p.x + size, cy2, size * 0.5, col, fade * 0.95, true);
      fxGlowFill(fx, "soft", col, p.x, cy2, size * 1.4, fade * 0.5);
      // 脚下绿金晕环（软扩张，末段归零）
      if (age < 0.7) {
        const rk = fxEaseOut(age / 0.7);
        fxRing(fx, p.x, p.y, (0.3 + rk * 0.6) * p.s, (0.13 + rk * 0.26) * p.s, Math.max(2, 0.045 * p.s), col, (1 - age / 0.7) * 0.6);
      }
    }
    // ⑦ 护盾泡（给队友套泡/屏障）：半球泡 + 底环 + 上升高光（形状独立于治疗/法术）
    for (const s of fxState.bubbles) {
      const age = (now - s.t) / 640;
      if (age < 0 || age > 1) continue;
      const p = fxAt(cam, s.x, s.y);
      const r = (0.55 + fxEaseOut(age) * 0.5) * p.s;
      const col = s.team === "red" ? "#ff9a7a" : "#7fd8ff";
      const a = Math.max(0, 0.9 - age * 0.8);
      fx.save();
      fx.globalCompositeOperation = "lighter";
      fx.globalAlpha = a;
      fx.strokeStyle = col;
      fx.lineWidth = Math.max(2, 0.05 * p.s);
      fx.beginPath();
      fx.ellipse(p.x, p.y - 0.95 * p.s, r * 0.72, r * 0.62, 0, Math.PI, Math.PI * 2);
      fx.moveTo(p.x + r * 0.72, p.y - 0.33 * p.s);
      fx.ellipse(p.x, p.y - 0.33 * p.s, r * 0.72, r * 0.16, 0, 0, Math.PI * 2);
      fx.stroke();
      fx.restore();
      fxGlowFill(fx, "soft", col, p.x, p.y - 0.9 * p.s, r * 1.15, a * 0.35);
      fxMotes(fx, p.x - r * 0.2, p.y - 1.15 * p.s, 0.3 * p.s, col, 0.6, 3, 8.4, age, "up", 0.04 * p.s);
    }
    // ⑧ 施法演出：咏唱光环（地面双环+职业徽记 sigil+旋转刻度+聚能粒子内收）→ 释放波（白芯冲击环）→ 逐技能签名形状。
    // 职业色系（入列时融色）：近卫红橙/狙击金/医疗绿/术师紫蓝/重装青灰/先锋橙/辅助青/特种品红。
    // 重做·区分度：前摇地面徽记按职业分形（FX_SIGIL：近卫三角/狙击方/医疗六边/术师六芒/重装五边/先锋方/
    // 辅助六芒/特种三角）——不看颜色只看形状就知道谁在吟唱；释放环尺寸与白芯占比同步加大。
    for (const c of fxState.casts) {
      const ms = now - c.t;
      if (ms > c.fx.dur) continue;
      const p = fxAt(cam, c.x, c.y);
      const s = p.s;
      const col = c.fx.color;
      // 咏唱/释放环走纯职业色（clr），签名形状走融合色（col）：职业可辨 + 技能语义色不丢
      const ring = c.fx.clr || col;
      const wind = Math.max(0, Math.min(c.fx.dur * 0.6, c.fx.windup || 0));
      if (wind > 0 && ms < wind) {
        // 咏唱光环：双层地环 + 职业徽记 sigil + 旋转刻度 + 聚能粒子内收 + 底部辉光（“蓄”感）
        const wk = ms / wind;
        fxRing(fx, p.x, p.y - 0.05 * s, (1.2 - wk * 0.32) * s, (0.5 - wk * 0.13) * s, Math.max(2, 0.05 * s), ring, 0.6 + wk * 0.3);
        // 职业徽记：n 边多边形（六边职业再叠一个倒三角 = "六芒"），随吟唱收缩并旋转
        const n = FX_SIGIL[c.role] || 6;
        fxPoly(fx, p.x, p.y - 0.05 * s, (0.92 - wk * 0.34) * s, (0.38 - wk * 0.14) * s, n, wk * 1.4, Math.max(1.5, 0.035 * s), ring, 0.5 + wk * 0.4);
        if (n === 6) fxPoly(fx, p.x, p.y - 0.05 * s, (0.92 - wk * 0.34) * s, (0.38 - wk * 0.14) * s, 3, -wk * 1.4 + Math.PI, Math.max(1.5, 0.03 * s), ring, 0.4 + wk * 0.35, false);
        const rot = wk * 1.9;
        fx.save();
        fx.globalCompositeOperation = "lighter";
        fx.globalAlpha = 0.6 + wk * 0.3;
        fx.strokeStyle = ring;
        fx.lineWidth = Math.max(1.5, 0.04 * s);
        for (let k = 0; k < 6; k += 1) {
          const a2 = (Math.PI * 2 * k) / 6 + rot;
          const r0 = (1.32 - wk * 0.6) * s, r1 = r0 + 0.26 * s;
          fx.beginPath();
          fx.moveTo(p.x + Math.cos(a2) * r1, p.y - 0.05 * s + Math.sin(a2) * r1 * 0.42);
          fx.lineTo(p.x + Math.cos(a2) * r0, p.y - 0.05 * s + Math.sin(a2) * r0 * 0.42);
          fx.stroke();
        }
        fx.restore();
        fxMotes(fx, p.x, p.y - 0.55 * s, 0.9 * s, ring, 0.8, 8, 2.2, wk, "in", 0.052 * s);
        fxGlowFill(fx, "soft", ring, p.x, p.y - 0.55 * s, (0.3 + wk * 0.4) * s, 0.45 + wk * 0.35);
        continue;
      }
      const relMs = ms - wind;
      const age = Math.max(0, relMs) / Math.max(1, c.fx.dur - wind);
      const alpha = age < 0.1 ? 0.5 + Math.min(1, age / 0.1) * 0.5 : Math.max(0, 1 - (age - 0.1) / 0.9);
      // 释放波：白芯冲击环 + 色环（320ms 快收，尺寸/白芯占比加大 = "放出来"的顿帧）；
      // 重击叠落点预警圈（下层，蓝金/红）
      if (relMs < 320) {
        const rk = fxEaseOut(relMs / 320);
        fxRing(fx, p.x, p.y - 0.35 * s, (0.5 + rk * 2.3) * s, (0.2 + rk * 0.94) * s, Math.max(3, 0.1 * s), ring, (1 - rk) * 0.98);
        fxRing(fx, p.x, p.y - 0.35 * s, (0.35 + rk * 1.6) * s, (0.14 + rk * 0.66) * s, Math.max(2, 0.06 * s), "#ffffff", (1 - rk) * 0.75, false);
        fxGlowFill(fx, "soft", ring, p.x, p.y - 0.35 * s, (0.55 + rk * 1.2) * s, (1 - rk) * 0.5);
      }
      if (c.fx.heavy && age < 0.85) {
        fxRing(fx, p.x, p.y, (0.45 + age * 1.35) * s, (0.18 + age * 0.54) * s, Math.max(2, 0.055 * s),
          c.team === "red" ? "#ff6b52" : "#ffd84a", 0.55 * (1 - age), false);
      }
      fx.save();
      switch (c.fx.shape) {
        case "wave":   // 横扫波（真银斩类）：宽幅三层弧线掠过 + 内层细弧 + 掠光粒子
          fxArc(fx, p.x, p.y - 0.75 * s, (1 + age * 2.2) * s, Math.PI * 1.05, Math.PI * 1.95, Math.max(4, 0.13 * s), col, alpha, true);
          fxArc(fx, p.x, p.y - 0.75 * s, (1 + age * 2.2) * s - 0.24 * s, Math.PI * 1.1, Math.PI * 1.9, Math.max(2, 0.055 * s), col, alpha * 0.6, false);
          fxMotes(fx, p.x, p.y - 0.75 * s, (1 + age) * s, col, alpha * 0.5, 6, 5.5, age, "out", 0.05 * s);
          break;
        case "pillar": // 火山类：立柱火舌 + 根部辉光 + 升腾火星
          for (let k = -1; k <= 1; k += 1) {
            const bx = p.x + k * 0.8 * s;
            fxBeam(fx, bx, p.y, bx + k * 0.1 * s, p.y - (0.55 + age * 1.7) * s, Math.max(3, 0.12 * s), col, alpha * (k === 0 ? 1 : 0.7), k === 0);
          }
          fxGlowFill(fx, "soft", col, p.x, p.y - 0.3 * s, (0.75 + age * 0.85) * s, alpha * 0.55);
          fxMotes(fx, p.x, p.y - 0.6 * s, 0.8 * s, col, alpha * 0.8, 6, 7.7, age, "up", 0.055 * s);
          break;
        case "nova":   // 奇美拉/秽壤/炎爆：新星径向爆发 + 冲击环 + 中心星闪
          {
            const r = (0.6 + age * 1.8) * s;
            fxGlowFill(fx, "nova", col, p.x, p.y - 0.6 * s, r, alpha);
            fxRing(fx, p.x, p.y - 0.6 * s, r * 0.72, r * 0.32, Math.max(2, 0.06 * s), col, alpha * 0.85);
            fxFlare(fx, p.x, p.y - 0.6 * s, r * 0.42, "#ffffff", Math.max(0, alpha * (1 - age) * 0.9), 4, 0.5);
            fxMotes(fx, p.x, p.y - 0.6 * s, r * 0.8, col, alpha * 0.8, 8, 8.8, age, "out", 0.055 * s);
          }
          break;
        case "cross":  // 治疗技：大十字绽放 + 柔光（绿金口径同 blooms）
          {
            const k2 = (0.6 + age * 1.2) * s;
            fxBeam(fx, p.x, p.y - 1.2 * s - k2 * 0.2, p.x, p.y - 1.2 * s - k2 * 0.2 + k2, Math.max(3, 0.11 * s), col, alpha, true);
            fxBeam(fx, p.x - k2 / 2, p.y - 1.0 * s - k2 * 0.2, p.x + k2 / 2, p.y - 1.0 * s - k2 * 0.2, Math.max(3, 0.11 * s), col, alpha, true);
            fxGlowFill(fx, "soft", col, p.x, p.y - 1.0 * s, k2 * 1.2, alpha * 0.5);
            fxMotes(fx, p.x, p.y - 1.0 * s, 0.5 * s, "#ffe9a8", alpha * 0.7, 5, 9.9, age, "up", 0.042 * s);
          }
          break;
        case "coins":  // 回费/支援：金色光点上浮
          fxMotes(fx, p.x, p.y - 0.2 * s, 0.75 * s, "#ffd24a", alpha, 7, 2.7, age, "up", 0.05 * s);
          fxGlowFill(fx, "soft", "#ffd24a", p.x, p.y - 0.5 * s, 0.45 * s, alpha * 0.4);
          break;
        case "chevrons": // 强化：上行箭羽（三层弧线）
          for (let k = 0; k < 3; k += 1) {
            const yy = p.y - (0.4 + k * 0.35 + age * 0.8) * s;
            fxArc(fx, p.x, yy + 0.28 * s, 0.34 * s, Math.PI * 1.18, Math.PI * 1.82, Math.max(2.5, 0.06 * s), col, alpha, true);
          }
          fxGlowFill(fx, "soft", col, p.x, p.y - 0.85 * s, 0.55 * s, alpha * 0.35);
          break;
        case "bubble": // 给队友套泡：泡罩自脚升起 + 底环
          fx.save();
          fx.globalCompositeOperation = "lighter";
          fx.globalAlpha = alpha * 0.9;
          fx.strokeStyle = col;
          fx.lineWidth = Math.max(2, 0.05 * s);
          fx.beginPath();
          fx.ellipse(p.x, p.y - 0.9 * s, (0.5 + age * 0.6) * s * 0.8, (0.42 + age * 0.5) * s, 0, Math.PI, Math.PI * 2);
          fx.moveTo(p.x + (0.5 + age * 0.6) * s * 0.8, p.y - 0.28 * s);
          fx.ellipse(p.x, p.y - 0.28 * s, (0.5 + age * 0.6) * s * 0.8, (0.14 + age * 0.1) * s, 0, 0, Math.PI * 2);
          fx.stroke();
          fx.restore();
          fxGlowFill(fx, "soft", col, p.x, p.y - 0.85 * s, (0.7 + age * 0.4) * s, alpha * 0.4);
          break;
        case "shield": // 防御：六边形护盾（外/内两层）+ 上升光尘
          for (let pass = 0; pass < 2; pass += 1) {
            const rr = (pass === 0 ? 0.8 : 0.5) + age * 0.3;
            fx.save();
            fx.lineWidth = Math.max(2, 0.055 * s);
            fx.globalCompositeOperation = "lighter";
            fx.globalAlpha = alpha * (pass === 0 ? 1 : 0.6);
            fx.strokeStyle = col;
            fx.beginPath();
            for (let k = 0; k < 6; k += 1) {
              const a2 = Math.PI / 3 * k + Math.PI / 6;
              const xx = p.x + Math.cos(a2) * rr * s;
              const yy = p.y - 0.8 * s + Math.sin(a2) * rr * s * 0.7;
              k === 0 ? fx.moveTo(xx, yy) : fx.lineTo(xx, yy);
            }
            fx.closePath();
            fx.stroke();
            if (pass === 0) {
              fx.lineWidth = Math.max(1, 0.02 * s);
              fx.strokeStyle = "#ffffff";
              fx.globalAlpha = alpha * 0.8;
              fx.stroke();
            }
            fx.restore();
          }
          fxGlowFill(fx, "soft", col, p.x, p.y - 0.8 * s, 0.95 * s, alpha * 0.4);
          fxMotes(fx, p.x, p.y - 0.9 * s, 0.6 * s, col, alpha * 0.6, 4, 12.1, age, "up", 0.045 * s);
          break;
        case "fan":    // 连发：扇形箭羽（5 道三层线）
          for (let k = -2; k <= 2; k += 1) {
            fxBeam(fx, p.x, p.y - 0.8 * s, p.x + k * 0.75 * s, p.y - 0.8 * s - (0.9 + age * 1.1) * s + Math.abs(k) * 0.12 * s,
              Math.max(2, 0.05 * s), col, alpha, k === 0);
          }
          break;
        case "rain":   // 剑雨：密集光刺自上而下（7 道，错拍）+ 落点溅光
          for (let k = -3; k <= 3; k += 1) {
            const xx = p.x + k * 0.45 * s;
            const yy = p.y - 1.4 * s + ((age * 2.2 + k * 0.14 + 3) % 1) * 1.6 * s;
            fxBeam(fx, xx, yy, xx - 0.06 * s, yy + 0.38 * s, Math.max(2, 0.05 * s), col, alpha * 0.85, k === 0);
          }
          fxMotes(fx, p.x, p.y, 1.1 * s, col, alpha * 0.5, 6, 6.1, age, "out", 0.05 * s);
          break;
        case "slam":   // 砸地冲击：地面环 + 上抛碎片 + 尘 + 辉光
          {
            const g0 = (0.3 + fxEaseOut(age) * 1.3) * s;
            fxRing(fx, p.x, p.y, g0, g0 * 0.42, Math.max(2.5, 0.065 * s), col, alpha);
            for (let k = -2; k <= 2; k += 1) {
              const bx = p.x + k * 0.34 * s;
              const h2 = (0.25 + age * (0.9 - Math.abs(k) * 0.18)) * s;
              fx.save();
              fx.globalCompositeOperation = "source-over";
              fx.globalAlpha = alpha * 0.85;
              fx.fillStyle = FX_EDGE;
              fx.beginPath();
              fx.moveTo(bx - 0.11 * s, p.y);
              fx.lineTo(bx, p.y - h2);
              fx.lineTo(bx + 0.11 * s, p.y);
              fx.closePath();
              fx.fill();
              fx.globalCompositeOperation = "lighter";
              fx.globalAlpha = alpha * 0.75;
              fx.fillStyle = col;
              fx.fill();
              fx.restore();
            }
            fxGlowFill(fx, "soft", col, p.x, p.y - 0.1 * s, g0 * 0.9, alpha * 0.55);
            fxMotes(fx, p.x, p.y - 0.05 * s, g0, "#b9b2a4", alpha * 0.5, 6, 15.3, age, "out", 0.07 * s, "source-over");
          }
          break;
        case "spikes": // 棘刺环（荆棘/护身尖刺）
          {
            const r = (0.45 + age * 0.55) * s;
            fxRing(fx, p.x, p.y - 0.55 * s, r, r * 0.5, Math.max(2, 0.05 * s), col, alpha);
            for (let k = 0; k < 8; k += 1) {
              const a2 = (Math.PI * 2 * k) / 8 + age * 0.6;
              const c2 = Math.cos(a2), s2 = Math.sin(a2);
              fxBeam(fx, p.x + c2 * r * 0.85, p.y - 0.55 * s + s2 * r * 0.42, p.x + c2 * r * 1.45, p.y - 0.55 * s + s2 * r * 0.72,
                Math.max(2, 0.045 * s), col, alpha, false);
            }
          }
          break;
        case "saw":    // 旋锯双弧（力之锯）
          {
            const r = (0.75 + age * 0.25) * s;
            const rot2 = age * Math.PI * 2.2;
            fxArc(fx, p.x, p.y - 0.7 * s, r, rot2, rot2 + Math.PI * 0.72, Math.max(3, 0.075 * s), col, alpha, true);
            fxArc(fx, p.x, p.y - 0.7 * s, r, rot2 + Math.PI, rot2 + Math.PI * 1.72, Math.max(3, 0.075 * s), col, alpha, true);
            fxRing(fx, p.x, p.y - 0.7 * s, r * 0.45, r * 0.2, Math.max(2, 0.05 * s), col, alpha * 0.6, false);
            fxMotes(fx, p.x, p.y - 0.7 * s, r, col, alpha * 0.5, 5, 4.9, age, "out", 0.05 * s);
          }
          break;
        case "hex":    // 眩晕六边形（旋转琥珀色，与buff的chevrons区分）
          {
            const r = (0.55 + Math.sin(age * Math.PI * 3) * 0.08) * s;
            const rot = age * Math.PI * 1.8;
            fx.save();
            fx.translate(p.x, p.y - 0.6 * s);
            fx.rotate(rot);
            fxPoly(fx, 0, 0, r, 6, Math.max(2.5, 0.06 * s), col, alpha);
            fxPoly(fx, 0, 0, r * 0.6, 6, Math.max(1.5, 0.04 * s), col, alpha * 0.7);
            fx.restore();
            fxGlowFill(fx, "soft", col, p.x, p.y - 0.6 * s, r * 1.4, alpha * 0.4);
          }
          break;
        case "ripple": // 减速波纹（下沉涟漪，棕褐色，与ring区分）
          {
            const r0 = 0.3 * s, r1 = (0.3 + age * 0.9) * s;
            const a1 = alpha * (1 - age * 0.7);
            for (let i = 0; i < 3; i += 1) {
              const ph = (age + i * 0.15) % 1;
              const rr = r0 + (r1 - r0) * ph;
              fxRing(fx, p.x, p.y, rr, rr * 0.35, Math.max(2, 0.045 * s), col, a1 * (1 - ph), false);
            }
          }
          break;
        case "blast":  // 溅射爆发环（快速扩散+震波）
          {
            const r = (0.2 + fxEaseOut(age) * 1.2) * s;
            fxRing(fx, p.x, p.y, r, r * 0.5, Math.max(3, 0.07 * s), col, alpha);
            const r2 = (0.1 + age * 0.85) * s;
            fxRing(fx, p.x, p.y, r2, r2 * 0.42, Math.max(2, 0.05 * s), col, alpha * 0.6, false);
            fxMotes(fx, p.x, p.y, r * 0.8, col, alpha * 0.7, 8, 6.2, age, "out", 0.06 * s);
          }
          break;
        case "scorch": // 地面灼烧（持续区域：地面纹理+余烬粒子）
          {
            const r = 0.85 * s;
            fx.save();
            fx.globalAlpha = alpha * 0.45;
            fx.fillStyle = col;
            fx.beginPath();
            fx.ellipse(p.x, p.y, r, r * 0.45, 0, 0, Math.PI * 2);
            fx.fill();
            fx.restore();
            fxMotes(fx, p.x, p.y, r * 0.9, col, alpha * 0.75, 12, 3.5, age, "in", 0.055 * s, "source-over");
            const flicker = 0.5 + 0.5 * Math.sin(age * Math.PI * 8);
            fxGlowFill(fx, "soft", col, p.x, p.y, r * 0.6, alpha * 0.3 * flicker);
          }
          break;
        case "orbit":  // 环绕光点（日晷/儿时的舞乐）
          {
            const r = (0.6 + age * 0.35) * s;
            fxRing(fx, p.x, p.y - 0.6 * s, r, r * 0.45, Math.max(2, 0.05 * s), col, alpha * 0.75, false);
            for (let k = 0; k < 4; k += 1) {
              const a2 = age * Math.PI * 2.6 + (Math.PI * 2 * k) / 4;
              fx.save();
              fx.globalCompositeOperation = "lighter";
              fx.globalAlpha = alpha;
              fx.fillStyle = col;
              fx.beginPath();
              fx.arc(p.x + Math.cos(a2) * r, p.y - 0.6 * s + Math.sin(a2) * r * 0.45, Math.max(1.5, 0.05 * s), 0, Math.PI * 2);
              fx.fill();
              fx.restore();
            }
            fxGlowFill(fx, "soft", col, p.x, p.y - 0.6 * s, 0.6 * s, alpha * 0.4);
          }
          break;
        case "fangs":  // 双 crescent 合拢（狼魂）
          {
            const r = (0.8 - age * 0.35) * s;
            fxArc(fx, p.x - r * 0.55, p.y - 0.65 * s, r * 0.8, Math.PI * 1.45, Math.PI * 2.35, Math.max(3, 0.08 * s), col, alpha, true);
            fxArc(fx, p.x + r * 0.55, p.y - 0.65 * s, r * 0.8, Math.PI * 1.05, Math.PI * 1.95, Math.max(3, 0.08 * s), col, alpha, true);
            fxFlare(fx, p.x, p.y - 0.65 * s, 0.3 * s * (1 - age), col, alpha * 0.8, 4, 0.8);
          }
          break;
        case "charge": // 聚能（强力击/战术咏唱/冲锋模式等）：汇聚线 + 升腾光柱
          fxMotes(fx, p.x, p.y - 0.55 * s, 1.25 * s, col, alpha * 0.85, 8, 2.9, age, "in", 0.05 * s);
          fxBeam(fx, p.x, p.y, p.x, p.y - (0.45 + age * 1.55) * s, Math.max(3, 0.09 * s), col, alpha, true);
          fxGlowFill(fx, "soft", col, p.x, p.y - 0.55 * s, (0.5 + age * 0.3) * s, alpha * 0.5);
          break;
        case "ember":  // 余烬升腾（点燃）
          fxMotes(fx, p.x, p.y - 0.1 * s, 0.75 * s, col, alpha, 8, 3.7, age, "up", 0.05 * s);
          fxGlowFill(fx, "soft", col, p.x, p.y - 0.12 * s, 0.62 * s, alpha * 0.5);
          fxRing(fx, p.x, p.y, 0.55 * s, 0.16 * s, Math.max(2, 0.05 * s), col, alpha * 0.5, false);
          break;
        case "scorch": // 灼烧地面（灼地）：火圈 + 火舌 + 余烬
          {
            const r = (0.55 + age * 0.75) * s;
            fxRing(fx, p.x, p.y, r, r * 0.4, Math.max(2, 0.055 * s), col, alpha);
            for (let k = -2; k <= 2; k += 1) {
              const bx = p.x + k * 0.28 * s;
              const h2 = (0.22 + ((age * 3 + k * 0.37) % 1) * 0.42) * s;
              fxBeam(fx, bx, p.y, bx + k * 0.04 * s, p.y - h2, Math.max(2, 0.05 * s), col, alpha * 0.8, false);
            }
            fxGlowFill(fx, "soft", col, p.x, p.y - 0.12 * s, r * 0.9, alpha * 0.45);
            fxMotes(fx, p.x, p.y - 0.1 * s, r * 0.8, col, alpha * 0.6, 5, 10.6, age, "up", 0.045 * s);
          }
          break;
        case "leap":   // 飞行配套（与动作组 takeoff/levitate 对齐）：起飞气流 → 滞空漂浮粒子 → 落地尘
          if (age < 0.35) {
            const lk = age / 0.35;
            for (let k = -2; k <= 2; k += 1) {
              const bx = p.x + k * 0.28 * s;
              const h2 = (0.35 + fxEaseOut(lk) * 1.5 - Math.abs(k) * 0.2) * s;
              fxBeam(fx, bx, p.y, bx + k * 0.05 * s, p.y - h2, Math.max(2, 0.06 * s), col, (1 - lk) * 0.85, k === 0);
            }
            fxRing(fx, p.x, p.y, (0.35 + lk * 0.55) * s, (0.15 + lk * 0.23) * s, Math.max(2, 0.05 * s), col, (1 - lk) * 0.8);
            fxGlowFill(fx, "soft", col, p.x, p.y - 0.1 * s, 0.55 * s, (1 - lk) * 0.5);
          } else if (age < 0.7) {
            const hk = (age - 0.35) / 0.35;
            fxGlowFill(fx, "soft", col, p.x, p.y - 1.05 * s, 0.55 * s, 0.55 * (1 - hk * 0.3));
            fxMotes(fx, p.x, p.y - 1.0 * s, 0.7 * s, col, 0.7, 6, 4.4, hk, "up", 0.05 * s);
            fxRing(fx, p.x, p.y - 1.0 * s, (0.45 + hk * 0.12) * s, (0.19 + hk * 0.05) * s, Math.max(1.5, 0.035 * s), col, 0.5, false);
          } else {
            const gk = fxEaseOut((age - 0.7) / 0.3);
            fxRing(fx, p.x, p.y, (0.4 + gk * 1.1) * s, (0.17 + gk * 0.44) * s, Math.max(2.5, 0.06 * s), col, (1 - gk) * 0.9);
            fxMotes(fx, p.x, p.y - 0.08 * s, 0.9 * s, "#b9b2a4", 0.4, 6, 6.2, gk, "out", 0.07 * s, "source-over");
            fxGlowFill(fx, "soft", col, p.x, p.y - 0.12 * s, (0.5 + gk * 0.4) * s, (1 - gk) * 0.55);
          }
          break;
        case "reticle": // 瞄准（强力击·γ型）：收缩环 + 反向旋转六边 + 四向刻度 + 中心辉光
          {
            const r = (0.95 - age * 0.45) * s;
            fxRing(fx, p.x, p.y - 0.7 * s, r, r * 0.5, Math.max(2, 0.05 * s), col, alpha);
            fx.save();
            fx.globalCompositeOperation = "lighter";
            fx.globalAlpha = alpha * 0.85;
            fx.strokeStyle = col;
            fx.lineWidth = Math.max(1.5, 0.04 * s);
            fx.translate(p.x, p.y - 0.7 * s);
            fx.rotate(-age * 2.2);
            fx.beginPath();
            for (let k = 0; k < 6; k += 1) {
              const a2 = Math.PI / 3 * k + Math.PI / 6;
              const xx = Math.cos(a2) * r * 0.62, yy = Math.sin(a2) * r * 0.34;
              k === 0 ? fx.moveTo(xx, yy) : fx.lineTo(xx, yy);
            }
            fx.closePath();
            fx.stroke();
            fx.restore();
            for (let k = 0; k < 4; k += 1) {
              const a2 = (Math.PI / 2) * k + 0.4;
              fxBeam(fx, p.x + Math.cos(a2) * r * 1.15, p.y - 0.7 * s + Math.sin(a2) * r * 0.6,
                p.x + Math.cos(a2) * r * 1.5, p.y - 0.7 * s + Math.sin(a2) * r * 0.78, Math.max(2, 0.045 * s), col, alpha * 0.8, false);
            }
            fxGlowFill(fx, "orb", col, p.x, p.y - 0.7 * s, r * 0.55, alpha * 0.7);
          }
          break;
        case "shatter": // 护盾碎裂：六边碎裂 + 放射碎片 + 辉光
          {
            fx.save();
            fx.globalCompositeOperation = "lighter";
            fx.globalAlpha = alpha * (1 - age * 0.4);
            fx.strokeStyle = col;
            fx.lineWidth = Math.max(2, 0.05 * s);
            const rr = (0.55 + age * 0.75) * s;
            fx.beginPath();
            for (let k = 0; k < 6; k += 1) {
              const a2 = Math.PI / 3 * k + Math.PI / 6;
              const xx = p.x + Math.cos(a2) * rr, yy = p.y - 0.75 * s + Math.sin(a2) * rr * 0.72;
              k === 0 ? fx.moveTo(xx, yy) : fx.lineTo(xx, yy);
            }
            fx.closePath();
            fx.stroke();
            fx.restore();
            fxMotes(fx, p.x, p.y - 0.75 * s, 0.85 * s, col, alpha, 10, 17.9, age, "out", 0.055 * s);
            fxGlowFill(fx, "soft", col, p.x, p.y - 0.75 * s, (0.55 + age * 0.5) * s, alpha * 0.6);
          }
          break;
        case "telegraph": // 预警圈：外环收紧 + 内层斜纹（source-over）+ 内环
          {
            const r = (1.25 - age * 0.55) * s;
            fxRing(fx, p.x, p.y, r, r * 0.42, Math.max(2, 0.05 * s), col, alpha * 0.85);
            fx.save();
            fx.globalCompositeOperation = "source-over";
            fx.globalAlpha = alpha * 0.35;
            fx.fillStyle = col;
            for (let k = -3; k <= 3; k += 1) {
              const bx = p.x + k * 0.24 * s;
              fx.fillRect(bx - 0.03 * s, p.y - r * 0.34, 0.06 * s, r * 0.68);
            }
            fx.restore();
            fxRing(fx, p.x, p.y, r * 0.72, r * 0.3, Math.max(2, 0.045 * s), col, alpha * 0.8, false);
          }
          break;
        default:       // ring：双层扩散环（effect 族默认）
          fxRing(fx, p.x, p.y - 0.5 * s, (0.4 + age * 1.8) * s, (0.18 + age * 0.8) * s, Math.max(2, 0.06 * s), col, alpha);
          fxRing(fx, p.x, p.y - 0.5 * s, (0.22 + age * 1.15) * s, (0.1 + age * 0.5) * s, Math.max(1.5, 0.04 * s), "#ffffff", alpha * 0.55, false);
          fxMotes(fx, p.x, p.y - 0.5 * s, 0.8 * s, col, alpha * 0.5, 5, 8.2, age, "up", 0.045 * s);
      }
      fx.restore();
    }
    // ⑨ 入场方向环（原作 sprite_direction_ring）：贴图 + 柔光底
    for (const r of fxState.rings) {
      const age = (now - r.t) / 520;
      if (age < 0 || age > 1) continue;
      const p = fxAt(cam, r.x, r.y);
      const img = hudTex("sprite_direction_ring");
      const size = (0.9 + age * 1.1) * p.s;
      fx.save();
      fx.globalAlpha = 1 - age;
      if (texReady(img)) fx.drawImage(img, p.x - size / 2, p.y - size * 0.32, size, size * 0.62);
      else { fx.strokeStyle = "#fff"; fx.lineWidth = 2; fx.beginPath(); fx.ellipse(p.x, p.y, size / 2, size * 0.31, 0, 0, Math.PI * 2); fx.stroke(); }
      fx.restore();
      fxGlowFill(fx, "soft", "#6fe7ff", p.x, p.y, size * 0.6, (1 - age) * 0.25);
    }
    // ⑩ 离场（形状/颜色语言按原因分流）：breach=蓝金收束（突入敌门=返回手牌，绝非死亡/爆炸）；
    // death=消散（暗烟+上飘余辉；空中单位无坠地感）；retreat/skillExit=轻收势淡出。
    for (const d of fxState.deaths) {
      const isBreach = d.kind === "breach";
      const dur = isBreach ? 420 : 520;
      const age = (now - d.t) / dur;
      if (age < 0 || age > 1) continue;
      const p = fxAt(cam, d.x, d.y);
      const k = fxEaseOut(age);
      if (isBreach) {
        // 破门=蓝金收束（配合撤退收势；绝非死亡/爆炸）：全程"向门收拢"的负空间演出——
        // ① 三道向门流动的光条（中线金/侧线蓝）② 内收粒子 ③ 由大收小的金环（收敛而非扩散）
        // ④ 目标端门环定点亮起（"收进去了"）⑤ 淡出辉光。无暗烟、无冲击星、无环爆。
        const col = "#5ce0ff", gold = "#ffdf7a";
        let dirAng = 0;
        if (d.to) {
          const q = fxAt(cam, d.to.x, d.to.y);
          dirAng = Math.atan2(q.y - p.y, q.x - p.x);
        }
        // ① 向门流光条（收束感来源：长度随年龄收缩、亮度递减）
        for (let i = -1; i <= 1; i += 1) {
          const off = i * 0.24 * p.s;
          const lx = p.x - Math.sin(dirAng) * off, ly = p.y - 0.5 * p.s + Math.cos(dirAng) * off * 0.5;
          const len = (0.95 + i * 0.2) * p.s * (1 - k * 0.55);
          fxBeam(fx, lx, ly, lx + Math.cos(dirAng) * len, ly + Math.sin(dirAng) * len * 0.55,
            Math.max(2, i === 0 ? 0.06 * p.s : 0.045 * p.s), i === 0 ? gold : col, (1 - age) * 0.9, i === 0);
        }
        // ② 内收粒子（mode "in"）+ ③ 收缩金环（负空间：由大收小）
        fxMotes(fx, p.x, p.y - 0.5 * p.s, 0.85 * p.s, col, 0.85, 10, 4.2, age, "in", 0.052 * p.s);
        fxRing(fx, p.x, p.y - 0.5 * p.s, (1 - k) * 0.95 * p.s + 0.08 * p.s, (1 - k) * 0.4 * p.s + 0.03 * p.s,
          Math.max(2, 0.055 * p.s), gold, (1 - age) * 0.9);
        fxRing(fx, p.x, p.y - 0.5 * p.s, (1 - k) * 0.62 * p.s + 0.05 * p.s, (1 - k) * 0.26 * p.s + 0.02 * p.s,
          Math.max(1.5, 0.035 * p.s), col, (1 - age) * 0.7, false);
        // ④ 门端定点亮环（收束终点反馈）
        if (d.to) {
          const q = fxAt(cam, d.to.x, d.to.y);
          const ga = Math.max(0, Math.min(1, (age - 0.45) / 0.55));
          if (ga > 0) {
            fxRing(fx, q.x, q.y, (0.3 + ga * 0.5) * p.s, (0.12 + ga * 0.2) * p.s,
              Math.max(2, 0.05 * p.s), gold, (1 - ga) * 0.8);
          }
        }
        // ⑤ 淡出辉光
        fxGlowFill(fx, "soft", col, p.x, p.y - 0.55 * p.s, 0.72 * p.s * (1 - age * 0.35), (1 - age) * 0.55);
      } else if (d.kind === "death") {
        // 死亡消散：暗烟（source-over 实体感）+ 上飘余辉 + 收缩落地环（空中单位无坠地感）
        const col = d.team === "red" ? FX_ACCENT.red : FX_ACCENT.blue;
        fx.save();
        fx.globalCompositeOperation = "source-over";
        fxGlowFill(fx, "soft", "#242a35", p.x, p.y - 0.5 * p.s, (0.55 + k * 0.45) * p.s, (1 - age) * 0.5);
        fx.restore();
        fxMotes(fx, p.x, p.y - 0.45 * p.s, 0.7 * p.s, col, 0.55, 8, 13.7 + d.x, age, "up", 0.05 * p.s);
        if (!d.air) fxRing(fx, p.x, p.y, (0.75 - k * 0.5) * p.s, (0.3 - k * 0.2) * p.s, Math.max(2, 0.045 * p.s), col, (1 - age) * 0.5, false);
      } else {
        // 撤退/技能退场：轻收势淡出（小光环 + 浮尘）
        const col = d.team === "red" ? FX_ACCENT.red : FX_ACCENT.blue;
        fxRing(fx, p.x, p.y, (0.5 + k * 0.3) * p.s, (0.2 + k * 0.12) * p.s, Math.max(1.5, 0.035 * p.s), col, (1 - age) * 0.5, false);
        fxGlowFill(fx, "soft", col, p.x, p.y - 0.5 * p.s, 0.5 * p.s, (1 - age) * 0.35);
        fxMotes(fx, p.x, p.y - 0.5 * p.s, 0.5 * p.s, col, 0.5, 5, 3.3 + d.y, age, "up", 0.04 * p.s);
      }
    }
    // ⑪ 飘字（大数字保留 + 顿帧感）：出生 pop + 快升慢停 + 深描边 + 底部色晕（数字自身即色块）。
    // 重做·颜色口径：治疗=绿金（青绿字 + 金描边）、我方受击=警示红（红字 + 红晕，一眼知道自己在掉血）、
    // 敌方受击=敌方色（橙红，与被治疗/我方受击三色可辨）；不再一律白字。
    for (const f of fxState.floats) {
      const age = (now - f.t) / 1400;
      if (age < 0 || age > 1) continue;
      const p = fxAt(cam, f.x, f.y);
      const y = p.y - 1.2 * p.s - fxEaseOut(Math.min(1, age * 1.8)) * 0.75 * p.s;
      const pop = age < 0.08 ? 1.38 - (age / 0.08) * 0.38 : 1;
      const mine = f.team === state.team;
      const col = f.heal ? "#5cff9a" : mine ? "#ff5252" : "#ffb072";
      const edge = f.heal ? FX_HEAL_GOLD : "#240a0a";
      const size = Math.max(14, 0.26 * p.s) * pop;
      fx.save();
      fx.globalAlpha = Math.max(0, 1 - age * age);
      fx.font = `bold ${size}px Consolas, Microsoft YaHei`;
      fx.textAlign = "center";
      fx.globalCompositeOperation = "lighter";
      fx.globalAlpha *= 0.55;                                   // 色晕（lighter，深浅底皆跳）
      fx.fillStyle = col;
      fx.fillText(f.text, p.x, y + size * 0.06);
      fx.globalCompositeOperation = "source-over";
      fx.globalAlpha = Math.max(0, 1 - age * age);
      fx.lineWidth = 4.5;                                       // 深描边加粗（对比度）
      fx.strokeStyle = f.heal ? "rgba(8,20,10,.92)" : "rgba(10,12,16,.94)";
      fx.strokeText(f.text, p.x, y);
      fx.lineWidth = 1.6;                                       // 内描边（治疗走金、伤害走白）
      fx.strokeStyle = edge;
      fx.strokeText(f.text, p.x, y);
      fx.fillStyle = f.heal ? "#eaffe8" : mine ? "#ffe4e4" : "#fff2e6";
      fx.fillText(f.text, p.x, y);
      fx.restore();
    }
    // ⑫ 屏幕闪白（仅重击）：峰值 0.14、150ms、二次衰减（设置“降低特效”关闭）
    // 全屏闪烁特效已禁用（用户反馈：影响观感）
    // const fl = fxState.flash;
    // if (fl && now >= fl.t && now < fl.until) {
    // const k = (fl.until - now) / (fl.until - fl.t);
    // fx.save;
    // fx.globalAlpha = 0.14 * k * k;
    // fx.fillStyle = "#ffffff";
    // fx.fillRect(0, 0, fx.canvas.width, fx.canvas.height);
    // fx.restore;
    // }
    // 自计时（探针断言“每帧毫秒级”；只累加标量，不分配）
    const fxDt = performance.now() - t0;
    fxPerf.sum += fxDt;
    fxPerf.n += 1;
    if (fxDt > fxPerf.max) fxPerf.max = fxDt;
  }

  // —— 特效诊断钩子（仅截图/性能探针用；不参与玩法、不建 DOM）——
  // pulse(name[, x, y])：固定相位重放单个场景（截图确定性）；cost：drawFx 自计时；count：各族在场事件数。
  // solo=true：先清空**全部**族（含自然对局事件），截图帧只剩该场景——区分度/配色的量化指标不被混战污染。
  function fxScenario(name, x, y, solo) {
    const now = performance.now();
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const v = state.view, u = v && v.units && v.units[0];
      x = u ? u.x : 8; y = u ? u.y : 6;
    }
    // 固定相位重放：先清同场景旧事件（_scn 标记），截图帧确定一致
    for (const key of FX_LIFE_KEYS) {
      const arr = fxState[key];
      let w = 0;
      for (let i = 0; i < arr.length; i += 1) if (!solo && arr[i]._scn !== name) arr[w++] = arr[i];
      arr.length = w;
    }
    if (solo) fxState.flash = null;
    const sc = (e) => (e._scn = name, e);
    // 各场景带 team/clr/role 等新字段（飘字配色、职业徽记、受击方阵营色都要它们才准确）
    const CTEAM = state.team || "blue";
    const VTEAM = CTEAM === "blue" ? "red" : "blue";
    switch (name) {
      case "attack":   // 普攻：弧光中段 + 命中迸发 + 伤害飘字
        fxState.slashes.push(sc({ x, y, from: { x: x - 1.1, y: y + 0.8 }, t: now - 110, team: CTEAM, heavy: false, combo: 0 }));
        fxState.hits.push(sc({ x, y, t: now - 60, team: CTEAM, heavy: false, vteam: VTEAM, life: 300 }));
        fxState.floats.push(sc({ x, y, t: now - 220, text: "-126", heal: false, team: VTEAM }));
        break;
      case "cast":     // 施法：前摇已过、释放波中段（术师职业色 + 六芒徽记）
        fxState.casts.push(sc({ x, y, t: now - 360, team: CTEAM, life: 940, role: "术师",
          fx: { shape: "nova", color: fxTintFor(fxClassBlend("#b96bff", "术师"), CTEAM), clr: fxTintFor(FX_CLASS.术师, CTEAM), dur: 900, heavy: true, windup: 300, effect: "burst" } }));
        break;
      case "chant":    // 咏唱前摇帧：咏唱圈 + 职业徽记 + 聚能粒子（施法"蓄"段对照）
        fxState.casts.push(sc({ x, y, t: now - 120, team: CTEAM, life: 940, role: "术师",
          fx: { shape: "nova", color: fxTintFor(fxClassBlend("#b96bff", "术师"), CTEAM), clr: fxTintFor(FX_CLASS.术师, CTEAM), dur: 900, heavy: false, windup: 300, effect: "burst" } }));
        break;
      case "heal":     // 治疗：光柱/粒子升腾中段 + 治疗飘字
        fxState.blooms.push(sc({ x, y, t: now - 120, team: CTEAM }));
        fxState.floats.push(sc({ x, y, t: now - 260, text: "+126", heal: true, team: CTEAM }));
        break;
      case "hit":      // 受击：重击迸发 + 屏幕闪白 + 大数字（我方受击=警示红边 + 红字）
        fxState.hits.push(sc({ x, y, t: now - 55, team: VTEAM, heavy: true, air: false, vteam: CTEAM, life: 440 }));
        fxState.floats.push(sc({ x, y, t: now - 200, text: "-215", heal: false, team: CTEAM }));
        if (!fxState.flash) fxState.flash = { t: now - 30, until: now + 120 };
        break;
      case "hitfoe":   // 敌方受击：同一冲击星但走敌方色（与我方受击的红边/红字对照）
        fxState.hits.push(sc({ x, y, t: now - 55, team: CTEAM, heavy: true, air: false, vteam: VTEAM, life: 440 }));
        fxState.floats.push(sc({ x, y, t: now - 200, text: "-215", heal: false, team: VTEAM }));
        break;
      case "death":    // 死亡：消散（暗烟 + 上飘余辉）
        fxState.deaths.push(sc({ x, y, t: now - 130, team: VTEAM, kind: "death", air: false }));
        break;
      case "breach":   // 破门：蓝金收束（突入敌门=返回手牌，非阵亡/爆炸）
        fxState.deaths.push(sc({ x, y, t: now - 130, team: CTEAM, kind: "breach", air: false, to: { x: x + 2.5, y: y } }));
        break;
      case "retreat":  // 撤退收势（非死亡）：轻收势淡出
        fxState.deaths.push(sc({ x, y, t: now - 130, team: CTEAM, kind: "retreat", air: false }));
        break;
    }
  }
  window.__FX_DEBUG__ = {
    fx: fxState,
    pulse: fxScenario,
    cost: () => ({ avg: fxPerf.n ? fxPerf.sum / fxPerf.n : 0, max: fxPerf.max, n: fxPerf.n }),
    resetCost: () => { fxPerf.sum = 0; fxPerf.n = 0; fxPerf.max = 0; },
    count: () => {
      const o = {};
      for (const k of FX_LIFE_KEYS) o[k] = fxState[k].length;
      return o;
    },
  };

  // 模型未到时的轻量占位（消灭“色块”）：小阴影（drawUnitShadow 已绘）+ 淡色轮廓 + 头像小图，
  // 不再画大色块卡片；Spine 模型到位即由单位层替换。HP/技能条沿用 drawUnitHpBar。
  function drawUnitCard(unit, cam) {
    const op = operator(unit.opId);
    const z = heightAt(Math.round(unit.x), Math.round(unit.y));
    // 步态：由 unit-animations.js 驱动（按位移判定行走 → 腿摆动 + 上下起伏）
    let gait = null;
    try {
      if (typeof UnitMovementAnimation !== "undefined") gait = UnitMovementAnimation.update(unit, frameDt);
    } catch { gait = null; }
    const bob = gait ? gait.bobOffset : 0;
    const foot = cam.project(unit.x, unit.y, z + bob);
    const s = foot.s;
    ctx.save();
    ctx.translate(foot.x, foot.y);
    // 轻量站位：脚底光环 + 名牌（加载中/失败占位；不做卡片观感，不遮点击）
    const ring = 0.3 * s;
    ctx.beginPath();
    ctx.ellipse(0, 0, ring, ring * 0.38, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `${TEAM_COLOR[unit.team]}88`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, ring * 0.55, ring * 0.22, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `${TEAM_COLOR[unit.team]}44`;
    ctx.stroke();
    // 躯体 + 双腿（行走时摆动；静止时并拢）
    if (gait) {
      const bodyY = -0.40 * s;
      const swing = gait.legOffset * s * 1.6;
      ctx.strokeStyle = TEAM_COLOR[unit.team];
      ctx.lineWidth = Math.max(1.6, 0.05 * s);
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-0.05 * s, bodyY); ctx.lineTo(0.05 * s + swing, -0.02 * s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0.05 * s, bodyY); ctx.lineTo(-0.05 * s - swing, -0.02 * s); ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, bodyY - 0.07 * s, 0.13 * s, 0, Math.PI * 2);
      ctx.fillStyle = TEAM_COLOR[unit.team];
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.45)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    // 名牌（小字，脚上方）
    const label = op ? op.name : unit.opId;
    ctx.font = `bold ${Math.max(9, 0.13 * s)}px Microsoft YaHei`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(14,16,20,.66)";
    ctx.fillRect(-tw / 2 - 5, -0.72 * s, tw + 10, 0.22 * s);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(label, 0, -0.56 * s);
    ctx.restore();
    ctx.textAlign = "left";
    drawUnitHpBar(unit, cam);
    if (unit.id === state.selectedUnitId) {
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, 0.46 * s, 0.18 * s, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "#232323";
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  // 召唤物渲染（矢量占位符）
  function drawSummon(summon, cam) {
    const z = heightAt(Math.round(summon.x), Math.round(summon.y));
    const p = cam.project(summon.x, summon.y, z);
    const s = p.s * 0.5;
    const visual = summon.visual || {};
    const color = visual.color || '#a0a0a0';
    const icon = visual.icon || '?';
    const scale = visual.scale || 1.0;
    
    ctx.save();
    
    // 阴影
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + s * 0.3, s * 0.4 * scale, s * 0.15 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // 召唤物主体（菱形）
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const size = s * scale;
    ctx.moveTo(p.x, p.y - size * 0.6);
    ctx.lineTo(p.x + size * 0.5, p.y);
    ctx.lineTo(p.x, p.y + size * 0.6);
    ctx.lineTo(p.x - size * 0.5, p.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    // 图标
    ctx.globalAlpha = 1;
    ctx.font = `${Math.round(size * 0.6)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(icon, p.x, p.y);
    
    // 血条（如果有HP）
    if (summon.hp > 0 && summon.maxHp > 0) {
      const barW = size * 1.2;
      const barH = 4;
      const barY = p.y - size * 0.8;
      
      // 背景
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(p.x - barW/2, barY, barW, barH);
      
      // 血量
      const ratio = summon.hp / summon.maxHp;
      ctx.fillStyle = ratio > 0.5 ? '#6ac568' : ratio > 0.2 ? '#ffd24a' : '#ff5a4a';
      ctx.fillRect(p.x - barW/2, barY, barW * ratio, barH);
    }
    
    ctx.restore();
  }

  // 场上技能图标（原作：头顶黄色菱形宝石 + 高光/发光）与选中单位旁 READY 菱形按钮
  // 观感要求：不再是"一个纯色方块 + ◆ 字符"（用户反馈丑）。改为带描边、内高光、外发光的多边形宝石，
  // 就绪时呼吸脉冲；技能生效中改橙色，与脚下橙条同一语言。
  function drawGem(x, y, size, fill, stroke, glow, glyph) {
    ctx.save();
    ctx.translate(x, y);
    // 外发光
    if (glow) {
      const gr = ctx.createRadialGradient(0, 0, size * 0.2, 0, 0, size * 1.5);
      gr.addColorStop(0, glow);
      gr.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // 菱形宝石本体（竖长棱形，原作观感）
    const w = size * 0.74, h = size;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(w, 0);
      ctx.lineTo(0, h);
      ctx.lineTo(-w, 0);
      ctx.closePath();
    };
    path();
    ctx.fillStyle = fill;
    ctx.fill();
    // 内高光（上半面更亮：金属/宝石质感）
    ctx.save();
    path();
    ctx.clip();
    const lg = ctx.createLinearGradient(0, -h, 0, h);
    lg.addColorStop(0, "rgba(255,255,255,.55)");
    lg.addColorStop(0.45, "rgba(255,255,255,.08)");
    lg.addColorStop(1, "rgba(0,0,0,.22)");
    ctx.fillStyle = lg;
    ctx.fillRect(-w, -h, w * 2, h * 2);
    ctx.restore();
    path();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1.6, size * 0.12);
    ctx.stroke();
    // 中心符号
    if (glyph) {
      ctx.fillStyle = glyph.color;
      ctx.font = `bold ${Math.max(9, size * 0.72)}px Microsoft YaHei`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph.text, 0, 0);
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  function drawSkillMarkers(view, cam) {
    state.skillButton = null;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 420);
    for (const unit of view.units) {
      if (unit.team !== state.team || !manualSkill(unit)) continue;
      const op = operator(unit.opId);
      const z = heightAt(Math.round(unit.x), Math.round(unit.y));
      const foot = cam.project(unit.x, unit.y, z);
      const ready = unit.sp >= unit.spCost && !unit.skillActive;
      if (ready || unit.skillActive) {
        const size = Math.max(10, 0.17 * foot.s);
        const y = foot.y - 1.48 * foot.s;
        const on = unit.skillActive;
        drawGem(
          foot.x, y, size,
          on ? "#ff9a2e" : "#ffd12e",
          on ? "rgba(255,232,200,.98)" : "rgba(255,255,235,.98)",
          on ? `rgba(255,150,40,${0.20 + 0.16 * pulse})` : `rgba(255,214,60,${0.20 + 0.18 * pulse})`,
          { text: on ? "◆" : "◆", color: on ? "#3a1c00" : "#3a2a00" },
        );
      }

      if (unit.id === state.selectedUnitId) {
        // READY 菱形按钮（贴近单位）
        const bx = foot.x + 0.95 * foot.s;
        const by = foot.y - 0.65 * foot.s;
        const r = 34;
        state.skillButton = { x: bx, y: by, r };
        const on = unit.skillActive;
        drawGem(
          bx, by, r * 0.62,
          on ? "#2fa36b" : ready ? "#2f7fc4" : "rgba(58,62,70,.92)",
          "#ffffff",
          on ? "rgba(70,220,150,.30)" : ready ? "rgba(90,180,255,.30)" : null,
          { text: "E", color: "#fff" },
        );
        const label = on ? "生效中" : ready ? "就绪" : `${Math.floor(unit.sp)}/${unit.spCost}`;
        ctx.font = "bold 10px Consolas";
        const tw = ctx.measureText(label).width + 10;
        ctx.fillStyle = on || ready ? "rgba(16,24,20,.88)" : "rgba(30,30,30,.85)";
        drawRounded(bx - tw / 2, by + r * 0.62 + 5, tw, 15, 4);
        ctx.fill();
        ctx.strokeStyle = on ? "rgba(120,240,180,.6)" : ready ? "rgba(150,205,255,.6)" : "rgba(200,200,200,.25)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = on ? "#8ef0bb" : ready ? "#bcdcff" : "#fff";
        ctx.textAlign = "center";
        ctx.fillText(label, bx, by + r * 0.62 + 16);
        ctx.textAlign = "left";
      }
    }
  }

  // 战斗模型比例校准：身体包围盒高度归一到 ≈1.15 格（原作小人≈1.0~1.3 格）。
  // 身体包围盒：计算 bounds 时排除武器/旗帜/特效等非身体 attachment（见 BODY_EXCLUDE_RE），
  // 桃金娘的旗杆/特效不再把人“算小”；脚底 = 包围盒底。
  // 逐人 MODEL_CALIB 优先级最高（20 名基础干员系数目视校准过，直接乘在归一身高之上）；
  // 无法判定身体边界时回退全包围盒 + 逐人系数（同旧口径）。世界坐标/射程/玩法数值不变。
  const MODEL_TILES = 1.15;
  const MODEL_CALIB = {
    myrtle: 1.0, texas: 1.0, siege: 1.05, saria: 1.05, cuora: 1.05, hoshiguma: 1.1,
    melantha: 1.0, lappland: 1.0, silverash: 1.05, thorns: 1.0, mudrock: 1.12,
    kroos: 0.92, exusiai: 0.95, ash: 0.95, amiya: 0.95, eyjafjalla: 0.95, ifrit: 1.0,
    ptilopsis: 0.95, shining: 0.98, suzuran: 0.9,
  };
  // 非身体 attachment 名过滤（slot 名 / attachment 名 / skins 内 attachment 名任一命中）：
  // 官方抽取 skel 的配件命名带 weapon/gun/sword/blade/flag/banner/fx/effect/skill/atk/heal/
  // hurt/shield/buff 等词根（如 myrtle 的 B_Flagpole、siege 的 F_Weapon、ash 的 Weapon_A_*）。
  // 仅影响比例归一与脚底对齐，不隐藏任何贴图。借鉴 Stronghold render/spine.js clipBounds
  // “只统计真正绘制的部件”的思路，改为按名字剔除。
  const BODY_EXCLUDE_RE = /(weapon|gun|sword|blade|axe|hammer|mace|lance|spear|staff|wand|bow$|arrow|bullet|shell|grenade|projectile|cannon|flag|banner|streamer|tape|fx|effect|skill|atk|attack|heal|hurt|shield|buff|laser|magic|spell|fire|flame|thunder|lightning|spark|glow|smoke|aura|ring|circle|deco|accessory)/i;

  // ---- 动画命名约定（借鉴 anim-roles.mjs 的解析顺序，端口并简化）----
  // 官方 Spine 动画命名差异极大（Attack / Attack_Begin+Loop+End、Skill_2_Loop / Skill2_Loop / Skill_2、
  // Die 可缺、瞬发技能只有单个 Skill 剪辑 …），故按角色（Roles）解析一次后缓存，不在每帧猜名：
  // idle→Idle/Idle类/Default/首个；deploy→Start；attack→Attack→Begin+Loop+End→Combat→编号 Attack→skill 回退；
  // skill→Skill_n/Skilln/Skill_0n/Skill 前缀族（loop=P_Loop→P_Attack→P→P_Idle→P_Begin，begin/end/idle 伴生）→attack 回退；
  // die→Die→Die*→*_Die；move→Move 三段→Run 三段→Move*；hit→Hit（可缺）。
  // 我们抽取 skel 的动画名与 Stronghold 同源（官方战斗 Front 模型），映射规则。
  function animExactFind(names) {
    const exact = new Set(names);
    const lower = new Map();
    for (const n of names) { const k = n.toLowerCase(); if (!lower.has(k)) lower.set(k, n); }
    return (name) => (name && exact.has(name) ? name : lower.get(String(name).toLowerCase()) || null);
  }
  const animIsEdge = (n) => /_(begin|start|end)$/i.test(n);
  const animFirstLike = (names, re, ok) => names.filter((n) => re.test(n) && ok(n)).sort()[0] || null;
  function animTriple(find, prefix) {
    const begin = find(`${prefix}_Begin`) || find(`${prefix}_Start`);
    const loop = find(`${prefix}_Loop`) || find(prefix);
    const end = find(`${prefix}_End`);
    if (loop) return { begin: begin || null, loop, end: end || null };
    if (begin) return { begin: null, loop: begin, end: end || null };
    return null;
  }
  function resolveAnimRoles(names, skillIndex) {
    const find = animExactFind(names);
    const first = (re, ok = () => true) => animFirstLike(names, re, ok);
    const idle = find("Idle") || first(/(^|_)idle/i, (n) => !/skill|stun|down/i.test(n))
      || find("Default") || first(/^default/i) || names[0] || null;
    const deploy = find("Start") || idle;
    let attack = null;
    {
      const a = find("Attack");
      const begin = find("Attack_Begin") || find("Attack_Start");
      const end = find("Attack_End");
      const loop = find("Attack_Loop");
      const numbered = first(/^attack/i, (n) => !/down/i.test(n) && !animIsEdge(n));
      if (a) attack = { begin: null, loop: a, end: null };
      else if (loop) attack = { begin: begin || null, loop, end: end || null };
      else if (begin && numbered) attack = { begin, loop: numbered, end: end || null, via: "attackAny" };
      else if (begin) attack = { begin: null, loop: begin, end: end || null };
      else {
        const c = find("Combat") || numbered
          || first(/(^|_)attack/i, (n) => !/down/i.test(n) && !animIsEdge(n) && !/skill/i.test(n));
        if (c) attack = { begin: null, loop: c, end: null, via: "attackAny" };
      }
    }
    let skill = null;
    {
      const n = (skillIndex || 0) + 1;
      for (const P of [`Skill_${n}`, `Skill${n}`, `Skill_${String(n).padStart(2, "0")}`, "Skill"]) {
        const begin = find(`${P}_Begin`) || find(`${P}_Start`);
        const end = find(`${P}_End`);
        const ownIdle = find(`${P}_Idle`);
        const atk = find(`${P}_Attack`)
          || first(new RegExp(`^${P}_Attack`, "i"), (x) => !/down/i.test(x) && !animIsEdge(x));
        const single = find(P);
        const variant = P !== "Skill"
          ? first(new RegExp(`^${P}_`, "i"), (x) => !/down/i.test(x) && !animIsEdge(x) && !/_idle$/i.test(x))
          : null;
        const loop = find(`${P}_Loop`) || atk || single || variant || ownIdle || begin;
        if (loop) {
          skill = {
            begin: begin && begin !== loop ? begin : null,
            loop,
            end: end && end !== loop ? end : null,
            idle: ownIdle || null,
          };
          break;
        }
      }
      if (!skill && attack) skill = { begin: attack.begin, loop: attack.loop, end: attack.end, via: "attack", idle: null };
    }
    const die = find("Die") || first(/^die/i) || first(/_die$/i, (n) => !/stun/i.test(n)) || null;
    const move = animTriple(find, "Move") || animTriple(find, "Run")
      || (() => { const m = first(/^move/i, (n) => !animIsEdge(n)); return m ? { begin: null, loop: m, end: null } : null; })();
    // 受击短播：Hit → Stun（全语料 Hit=0、Stun=22：Stun 反应剪辑是最近似物，走 track 1 一次性）
    const hit = find("Hit") || find("Hit_1") || first(/^hit/i, (n) => !animIsEdge(n))
      || find("Stun") || first(/(^|_)stun/i, (n) => !animIsEdge(n)) || null;
    // 治疗输出动作（全语料仅个别模型带 Heal 名）：Heal → *_Heal；缺则调用点以 attack 剪辑过渡
    const heal = find("Heal") || first(/(^|_)heal/i, (n) => !animIsEdge(n)) || null;
    return { idle, deploy, attack, skill, die, move, hit, heal };
  }
  const MODEL_LOAD_CONCURRENCY = 6;   // 并行加载上限（屏幕内/新入场单位优先，其余走后台队列）
  const MODEL_LOAD_RETRIES = 2;       // 加载失败有限重试（修根因：瞬时网络/服务器竞态），耗尽才落占位
  const MODEL_RETRY_BACKOFF_MS = 500; // 指数退避基数：500ms → 1000ms
  const MODEL_FAIL_COOLDOWN_MS = 30000; // 失效缓存：失败条目冷却 30s 后自动再试；reload 可立即清除
  const MODEL_FADE_MS = 80;           // 前/后骨架换模轻量淡切时长（新旧实例交叠，不闪断）
  const MODEL_LOG_CAP = 240;          // 加载诊断日志环形上限
  const spineLayer = {
    app: null,
    models: new Map(),       // `opId|variant` -> Promise<spineData>（只缓存成功；失败走 failures 失效缓存）
    modelData: new Map(),    // `opId|variant` -> spineData（就绪后同步取用，热帧零 await）
    modelMeta: new Map(),    // `opId|variant` -> { base, spineVersion, missingRegions, textureDeps }（诊断）
    atlases: new Map(),      // base -> Promise<atlas>（成功才缓存；页贴图经 PIXI.BaseTexture 按 URL 共享）
    skels: new Map(),        // base -> Promise<Uint8Array>（成功才缓存）
    failures: new Map(),     // `opId|variant` -> { at, url, http, error, retries }（失效缓存，可手动/自动清除）
    loadLog: [],             // 加载诊断日志：资源 URL/HTTP 状态/骨骼版本/atlas 缺 region/贴图依赖
    backIndex: null,         // assets/spine/back-index.json：后向骨架索引（front-only 判定，按需加载）
    backIndexP: null,
    animPick: new Map(),     // `opId|variant|skillIndex` -> Roles（resolveAnimRoles 缓存，避免每帧正则扫描动画表）
    measureBy: new Map(),    // `opId|variant` -> 身体包围盒测量 { x, y, w, h, ok }（每变体测一次，热帧零计算）
    avatars: new Map(),      // opId -> 头像 Image（模型未到的轻量占位用）
    actors: new Map(),       // unitId -> actor（spine/variant/data/roles/anim/modelHeight/sm/fading）
    hpSeen: new Map(),       // unitId -> { hp }（快照 HP 差分：真实治疗/受击事件源，见 scanHpEvents）
    loading: new Set(),      // 加载中的 `opId|variant`
    queue: [],               // 后台加载队列 [{ opId, variant, pri }]
    active: 0,               // 并发计数
    staleOps: new Set(),     // reload(opId) 后待重建的 actor（只换显示模型，不改任何战斗状态）
    ready: false,
    warmedSig: "",

    async ensure() {
      if (this.app) return true;
      if (!window.PIXI || !PIXI.spine || !PIXI.spine38) return false;
      this.app = new PIXI.Application({
        view: unitCanvas, width: 960, height: 640,
        backgroundAlpha: 0, sharedTicker: true,
      });
      this.app.stage.sortableChildren = true;
      this.ready = true;
      return true;
    },

    modelBase(opId) {
      const op = operator(opId);
      return `assets/spine/${opId}/${op.charId}`;
    },

    // 后向骨架 base：常规同目录 `<charId>_back`（提取期页改名避冲突）；back-index.json 提供
    // front-only 判定与 base（异常布局时可用 back/ 子目录兜底，见 baseCandidates）
    backBase(opId) {
      return `${this.modelBase(opId)}_back`;
    },

    // 后向骨架索引（提取期写 public/assets/spine/back-index.json）：kind="front-only" 的干员
    // 不发起注定 404 的请求，直接走镜像翻转回退
    loadBackIndex() {
      if (!this.backIndexP) {
        this.backIndexP = (async () => {
          try {
            const res = await fetch("assets/spine/back-index.json");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.backIndex = await res.json();
            this.logEvent({ event: "back-index", ok: true, url: "assets/spine/back-index.json",
              entries: Object.keys((this.backIndex || {}).entries || {}).length });
          } catch (err) {
            this.backIndex = { entries: {} };
            this.logEvent({ event: "back-index", ok: false, url: "assets/spine/back-index.json", error: String(err) });
          }
          return this.backIndex;
        })();
      }
      return this.backIndexP;
    },

    backInfo(opId) {
      const ent = this.backIndex && this.backIndex.entries && this.backIndex.entries[opId];
      return ent || { kind: "unknown" };
    },

    // 诊断日志：资源 URL / HTTP 状态 / 骨骼版本 / atlas 缺 region / 贴图依赖（模型加载规范 口径）
    logEvent(rec) {
      rec.t = Math.round(performance.now());
      this.loadLog.push(rec);
      if (this.loadLog.length > MODEL_LOG_CAP) this.loadLog.splice(0, this.loadLog.length - MODEL_LOG_CAP);
      if (rec.ok === false) console.warn("[spine]", rec.event, rec.url || "", rec.http != null ? rec.http : "", rec.error || "");
      return rec;
    },

    // 头像小图缓存（加载占位；失败打 __failed 标，不再重试）
    avatarOf(opId) {
      let img = this.avatars.get(opId);
      if (!img) {
        img = new Image();
        img.__failed = false;
        img.addEventListener("error", () => { img.__failed = true; });
        img.src = `assets/avatars/${opId}.webp`;
        this.avatars.set(opId, img);
      }
      return img;
    },

    // atlas 页与 skel 建缓存（同 base 的重复干员共享；页贴图按 URL 走 PIXI 全局缓存，前后骨架
    // 共用同名页即共享贴图）。失败不写缓存（避免毒化缓存堵死重试），由 loadModel 有限重试。
    getAtlas(base) {
      if (!this.atlases.has(base)) {
        const p = (async () => {
          const url = `${base}.atlas`;
          const res = await fetch(url);
          if (!res.ok) throw Object.assign(new Error(`atlas HTTP ${res.status}`), { http: res.status, url });
          const atlasText = (await res.text()).replace(/\r\n/g, "\n");
          const pageNames = [];
          const lines = atlasText.split("\n");
          for (let i = 0; i < lines.length; i += 1) {
            if (lines[i] && lines[i] === lines[i].trim() && /\.(png|webp)$/i.test(lines[i])) pageNames.push(lines[i].trim());
          }
          return new Promise((resolve, reject) => {
            new PIXI.spine.TextureAtlas(atlasText, (page, done) => {
              const pageUrl = `${base.replace(/\/[^/]+$/, "/")}${page}`;
              const bt = PIXI.BaseTexture.from(pageUrl);
              if (bt && bt.on) bt.on("error", () => this.logEvent({ event: "page-error", ok: false, url: pageUrl, error: "贴图加载失败" }));
              done(bt);
            }, (res2) => {
              if (!res2) {
                reject(Object.assign(new Error("atlas 解析失败"), { url }));
                return;
              }
              res2.__pageNames = pageNames;
              resolve(res2);
            });
          });
        })();
        this.atlases.set(base, p);
        p.catch(() => { this.atlases.delete(base); });   // 失败条目不缓存（失效缓存可恢复）
      }
      return this.atlases.get(base);
    },

    getSkel(base) {
      if (!this.skels.has(base)) {
        const p = (async () => {
          const url = `${base}.skel`;
          const res = await fetch(url);
          if (!res.ok) throw Object.assign(new Error(`skel HTTP ${res.status}`), { http: res.status, url });
          return new Uint8Array(await res.arrayBuffer());
        })();
        this.skels.set(base, p);
        p.catch(() => { this.skels.delete(base); });     // 失败条目不缓存
      }
      return this.skels.get(base);
    },

    spineVersionOf(bytes) {
      const n = Math.min(bytes.length, 96);
      let head = "";
      for (let i = 0; i < n; i += 1) head += String.fromCharCode(bytes[i]);
      const m = head.match(/\d+\.\d+(?:\.\d+)*/);
      return m ? m[0] : null;
    },

    // 候选 base：常规同目录 `<charId>_back`；back-index 指定 base 优先；back/ 子目录为布局兜底
    baseCandidates(opId, variant) {
      const stem = this.modelBase(opId);
      if (variant !== "back") return [stem];
      const ent = this.backInfo(opId);
      const out = [];
      if (ent.kind === "back" && ent.base) out.push(`assets/spine/${opId}/${ent.base}`);
      const op = operator(opId);
      out.push(`${stem}_back`, `assets/spine/${opId}/back/${op.charId}_back`);
      return [...new Set(out)];
    },

    // 诊断：骨骼版本 + atlas 缺 region + 贴图依赖（仅记录，不影响渲染管线）
    describeModel(base, atlas, bytes, data) {
      const dir = base.replace(/\/[^/]+$/, "/");
      const pageNames = (atlas && atlas.__pageNames) || [];
      const missing = [];
      try {
        for (const skin of (data && data.skins) || []) {
          let list = [];
          try { list = (skin.getAttachments ? skin.getAttachments() : skin.attachments) || []; } catch { list = []; }
          for (const e of list) {
            const att = e && e.attachment;
            if (!att || (att.type !== 0 && att.type !== 2)) continue;   // 仅绘制类 attachment 需要 region
            const name = (e.name || att.name || "").trim();
            if (name && !atlas.findRegion(name)) missing.push(name);
          }
        }
      } catch { /* 诊断失败不挡渲染 */ }
      return {
        base,
        spineVersion: this.spineVersionOf(bytes),
        skelBytes: bytes.length,
        missingRegions: missing.slice(0, 16),
        missingRegionCount: missing.length,
        textureDeps: pageNames.map((p) => `${dir}${p}`),
      };
    },

    // 有限重试（2 次，指数退避）后才判失败；失败写 failures 失效缓存（冷却后自动再试 / reload 立即清除）
    async loadModel(opId, variant) {
      const key = `${opId}|${variant}`;
      let lastErr = null;
      let lastUrl = "";
      for (let attempt = 0; attempt <= MODEL_LOAD_RETRIES; attempt += 1) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, MODEL_RETRY_BACKOFF_MS * 2 ** (attempt - 1)));
        for (const base of this.baseCandidates(opId, variant)) {
          try {
            const atlas = await this.getAtlas(base);
            const bytes = await this.getSkel(base);
            const r38 = PIXI.spine38;
            const data = new r38.SkeletonBinary(new r38.AtlasAttachmentLoader(atlas)).readSkeletonData(bytes);
            const meta = this.describeModel(base, atlas, bytes, data);
            this.modelMeta.set(key, meta);
            this.logEvent({ event: "model-ready", ok: true, opId, variant, url: `${base}.*`, attempt, ...meta });
            return data;
          } catch (err) {
            lastErr = err;
            lastUrl = (err && err.url) || `${base}.*`;
            this.logEvent({ event: "model-attempt", ok: false, opId, variant, url: lastUrl,
              http: err && err.http != null ? err.http : null, attempt, error: String((err && err.message) || err) });
            if (err && err.http === 404) break;   // 该 base 不存在：换下一个 base（back/ 子目录兜底）
          }
        }
      }
      const fail = {
        at: performance.now(),
        retries: MODEL_LOAD_RETRIES,
        url: lastUrl,
        http: lastErr && lastErr.http != null ? lastErr.http : null,
        error: String((lastErr && lastErr.message) || lastErr),
      };
      this.failures.set(key, fail);
      this.logEvent({ event: "model-fail", ok: false, opId, variant, ...fail });
      throw lastErr || new Error("spine model load failed");
    },

    getModel(opId, variant = "front") {
      const key = `${opId}|${variant}`;
      if (!this.models.has(key)) {
        const fail = this.failures.get(key);
        if (fail && performance.now() - fail.at < MODEL_FAIL_COOLDOWN_MS) {
          return Promise.reject(Object.assign(new Error("spine 模型失效缓存冷却中"), { cached: true, ...fail }));
        }
        this.failures.delete(key);
        const p = this.loadModel(opId, variant);
        this.models.set(key, p);
        p.then((data) => { this.modelData.set(key, data); }).catch(() => { this.models.delete(key); });
      }
      return this.models.get(key);
    },

    // 并行加载调度：去重 + 优先级（屏幕内/新入场 10 > 场外 5 > 手牌预热 1），并发限流。
    // front-only 干员（back-index 判定）的后向请求直接跳过——镜像翻转回退即可。
    request(opId, pri, variant = "front") {
      const key = `${opId}|${variant}`;
      if (variant === "back" && this.backInfo(opId).kind === "front-only") return;
      if (this.modelData.has(key) || this.models.has(key) || this.loading.has(key)) return;
      const fail = this.failures.get(key);
      if (fail && performance.now() - fail.at < MODEL_FAIL_COOLDOWN_MS) return;   // 冷却中不重试（防风暴）
      const hit = this.queue.find((it) => it.opId === opId && it.variant === variant);
      if (hit) {
        if (pri > hit.pri) hit.pri = pri;
        return;
      }
      this.queue.push({ opId, variant, pri });
      this.queue.sort((a, b) => b.pri - a.pri);
      this.pump();
    },

    pump() {
      while (this.active < MODEL_LOAD_CONCURRENCY && this.queue.length) {
        const { opId, variant } = this.queue.shift();
        const key = `${opId}|${variant}`;
        if (this.modelData.has(key) || this.models.has(key)) continue;
        this.active += 1;
        this.loading.add(key);
        this.getModel(opId, variant).catch(() => {}).finally(() => {
          this.loading.delete(key);
          this.active -= 1;
          this.pump();
        });
      }
    },

    // 开局后台预载：当前地图双方手牌干员模型（低优先级，不挡场上单位）。
    // 蓝方默认前向、红方默认后向（后向缺失由镜像回退，front 预载即兜底源）。
    warmup(view) {
      const blue = (view.hand && view.hand.blue) || [];
      const red = (view.hand && view.hand.red) || [];
      const sig = `${blue.map((h) => h.opId).join(",")}|${red.map((h) => h.opId).join(",")}`;
      if (sig === this.warmedSig) return;
      this.warmedSig = sig;
      for (const h of blue) this.request(h.opId, 1, "front");
      for (const h of red) {
        this.request(h.opId, 1, "back");
        this.request(h.opId, 1, "front");
      }
    },

    // ---- 动画状态机（借鉴 render/spine.js SpineActor + anim-roles.mjs）----
    // 角色表：idle / deploy / attack{begin,loop,end} / skill{begin,loop,end,idle} / die / move / hit。
    // 事件驱动不重播：入场与技能动作一次性（边沿触发）、死亡一次性（播完淡出）、受击为轻量反应；
    // Idle/Move/Attack 为循环状态（与移动循环同性质，按状态切换，不因重复快照重播）。
    rolesFor(opId, variant, data, skillIndex) {
      const key = `${opId}|${variant}|${skillIndex || 0}`;
      let roles = this.animPick.get(key);
      if (!roles) {
        roles = resolveAnimRoles((data.animations || []).map((a) => a.name), skillIndex || 0);
        this.animPick.set(key, roles);
      }
      return roles;
    },

    durOf(data, name) {
      const a = (data.animations || []).find((x) => x.name === name);
      return a && a.duration > 0 ? a.duration : 1;
    },

    playClip(actor, name, loop, opts = {}) {
      if (!name || !actor.spine) return false;
      try {
        const e = actor.spine.state.setAnimation(0, name, !!loop);
        if (e) {
          if (opts.timeScale) e.timeScale = opts.timeScale;
          if (opts.mix != null) e.mixDuration = opts.mix;
          if (opts.start) e.trackTime = opts.start;
        }
        actor.anim = name;
        actor.animLoop = !!loop;
        return true;
      } catch {
        return false;
      }
    },

    queueClip(actor, name, loop, timeScale) {
      if (!name || !actor.spine) return false;
      try {
        const e = actor.spine.state.addAnimation(0, name, !!loop, 0);
        if (e && timeScale) e.timeScale = timeScale;
        actor.anim = name;
        actor.animLoop = !!loop;
        return true;
      } catch {
        return false;
      }
    },

    // 一次性动作（attack=命中事件 / heal=真实治疗事件，动画规范 §状态机）：短动作优先、不打断长动作、
    // 播完回休止态。剪辑回退链（重要）：Heal 类 → 攻击剪辑 → **技能 begin 段 → 首个非 idle 剪辑 → idle**。
    // 实测 17/464 骨架完全没有 Attack 剪辑（如 shining/exusiai/kroos 只有 Default|Interact|Move|Relax|Sit|Sleep，
    // 以及 15 名只有 Skill_*/Stun 的干员）——旧实现到 `if (!clip) return false` 直接静默失败，
    // 这些干员攻击/治疗**永远没有动作**（用户反馈口径正是“没有攻击动作”）。故补全回退，保证有动作可播。
    beginAction(actor, kind, now) {
      const sm = actor.sm;
      if (sm.mode !== "base") return false;        // 长动作（技能/入场/死亡/循环）不被打断
      const r = actor.roles;
      const atk = r.attack || null;
      const clip = (kind === "heal" ? (r.heal || (atk && atk.loop)) : (atk && atk.loop))
        || (r.skill && r.skill.begin)                 // 无攻击剪辑：用技能起手（举杖/抬手，含治疗施法姿态）
        || (r.skill && r.skill.loop)
        || r.hit                                      // 受击/眩晕反应剪辑（Stun 族）亦可作反应姿态
        || r.idle;
      if (!clip) return false;
      const begin = kind === "attack" && atk && atk.begin && atk.begin !== clip ? atk.begin : null;
      let dur = this.durOf(actor.data, clip);
      if (begin && this.playClip(actor, begin, false, { mix: 0.08 })) {
        this.queueClip(actor, clip, false);
        dur += this.durOf(actor.data, begin);
      } else if (!this.playClip(actor, clip, false, { mix: 0.1 })) {
        return false;
      }
      sm.mode = "act";
      sm.actKind = kind;
      sm.actUntil = now + Math.max(200, dur * 1000);
      return true;
    },

    // 快照 HP 差分事件（唯一驱动源=快照事件，不改 sim）：HP 上升=真实治疗（治疗动作只认它）；
    // HP 下降=受击（攻击一次性动作按“最近敌方”归属，与特效层弹道归属同口径 4.2 格）。
    scanHpEvents(view) {
      const heals = [], strikes = [];
      const seen = new Set();
      for (const u of view.units) {
        seen.add(u.id);
        const rec = this.hpSeen.get(u.id);
        if (!rec) { this.hpSeen.set(u.id, { hp: u.hp }); continue; }
        const d = u.hp - rec.hp;
        if (d > 0.5) heals.push({ x: u.x, y: u.y, team: u.team, id: u.id, d });
        else if (d < -0.5) {
          let best = null, bestD = 4.2 * 4.2;
          for (const a of view.units) {
            if (a.team === u.team) continue;
            const dx = a.x - u.x, dy = a.y - u.y, d2 = dx * dx + dy * dy;
            if (d2 <= bestD) { bestD = d2; best = a; }
          }
          strikes.push({ id: best && best.id, x: u.x, y: u.y, team: u.team });
        }
        rec.hp = u.hp;
      }
      for (const id of [...this.hpSeen.keys()]) if (!seen.has(id)) this.hpSeen.delete(id);
      return { heals, strikes };
    },

    // 回休止态（idle/move）统一收口：播 base 循环剪辑（ts=步态 timeScale）并记录已显示休止态
    resumeBase(actor, ts = 1) {
      this.playClip(actor, this.baseClipName(actor), true, { timeScale: ts, mix: 0.15 });
      actor.sm.baseShown = actor.sm.base;
    },

    // 休止态剪辑：Move 循环优先（随移速），技能自带 idle（如 Skill_n_Idle）在技能期替代 idle
    baseClipName(actor) {
      const r = actor.roles;
      if (actor.sm.base === "move" && r.move && r.move.loop) return r.move.loop;
      if (actor.sm.skillOn && r.skill && r.skill.idle && r.skill.idle !== r.skill.loop) return r.skill.idle;
      return r.idle;
    },

    // 技能开/关一次性动作（借鉴 spine.js setSkill）：Begin→(自有 idle|Loop)→End；
    // 瞬发技能（无 Begin/独立 Idle 的单剪辑）按自身长度播完再收（skillEndPending）
    setSkill(actor, on, now) {
      const sm = actor.sm;
      if (on === sm.skillOn) return;
      sm.skillOn = on;
      if (sm.mode === "die") return;
      const sk = actor.roles.skill;
      if (!sk) return;
      if (!on && sm.mode === "deploy") return;      // 入场剪辑播完再收
      if (on) {
        sm.skillEndPending = false;
        sm.skillClipOnce = false;
        if (sk.begin) {
          sm.mode = "skillBegin";
          this.playClip(actor, sk.begin, false, { mix: 0.08 });
          sm.skillBeginUntil = now + this.durOf(actor.data, sk.begin) * 1000;
          const next = sk.idle && sk.idle !== sk.loop ? sk.idle : sk.loop;
          if (next) this.queueClip(actor, next, true);
        } else if (!sk.idle && sk.loop && sk.via !== "attack"
          && sk.loop !== (actor.roles.attack && actor.roles.attack.loop)) {
          sm.mode = "skillBegin";
          sm.skillClipOnce = true;
          this.playClip(actor, sk.loop, false, { mix: 0.08 });
          sm.skillBeginUntil = now + Math.max(200, this.durOf(actor.data, sk.loop) * 1000);
        } else if (sk.loop) {
          sm.mode = "skillLoop";
          const loopDur = this.durOf(actor.data, sk.loop);
          const ts = sk.via === "attack" ? Math.min(4, Math.max(0.35, loopDur / actor.interval)) : 1;
          this.playClip(actor, sk.loop, true, { timeScale: ts, mix: 0.12 });
        }
      } else {
        if (sm.skillClipOnce && now < sm.skillBeginUntil) { sm.skillEndPending = true; return; }
        sm.skillClipOnce = false;
        if (sk.end) {
          sm.mode = "skillEnd";
          this.playClip(actor, sk.end, false, { mix: 0.08 });
          sm.skillEndUntil = now + this.durOf(actor.data, sk.end) * 1000;
        } else {
          sm.mode = "base";
          this.playClip(actor, this.baseClipName(actor), true, { mix: 0.15 });
          sm.baseShown = sm.base;
        }
      }
    },

    // 被击败一次性：Die 剪辑播完淡出；无 Die 剪辑则定格 idle 首帧（借鉴 spine.js die：死后不再循环攻击）
    beginDie(actor, now) {
      const sm = actor.sm;
      sm.mode = "die";
      sm.skillOn = false;
      sm.fadeTail = 500;
      let dur = 0;
      // 背影骨架几乎都无 Die 剪辑（盘点 9/428）：倒地演出让位前向骨架的 Die（借鉴 Stronghold DESIGN §22.1），
      // 无前向数据则维持现骨架定格淡出
      if (!actor.roles.die && actor.variant === "back" && this.modelData.has(`${actor.opId}|front`)) {
        this.switchVariant(actor, actor.unit || { opId: actor.opId, skillIndex: 0 }, "front", now);
      }
      const d = actor.roles.die;
      if (d && this.playClip(actor, d, false, { mix: 0.05 })) {
        dur = this.durOf(actor.data, d) * 1000;
      } else {
        try {
          const e = actor.spine.state.setAnimation(0, actor.roles.idle, false);
          if (e) e.timeScale = 0;
        } catch { /* 模型异常不挡帧 */ }
      }
      sm.dieUntil = now + dur + 500;   // 500ms 淡出尾巴
    },

    // 撤退/技能退场/破门离场一次性：撤退收势快淡出（非死亡剪辑；与阵亡的死亡演出区分——破门≠阵亡）
    beginRetreat(actor, now) {
      const sm = actor.sm;
      sm.mode = "die";
      sm.skillOn = false;
      sm.fadeTail = 260;
      sm.dieUntil = now + 260;
    },

    // 身体包围盒（创建时测量一次，缓存复用）。几何法（借鉴 Stronghold render/spine.js poseRect：
    // Region 用 width/height×scale 过 bone.matrix 取四角、Mesh 用 computeWorldVertices）——不依赖贴图
    // 解码时序，逐次稳定；跳过 BoundingBox/Clipping/Path 等不绘制的 attachment。
    // 非身体件（BODY_EXCLUDE_RE：武器/旗帜/特效…，从 slot/attachment/skins·attachments 名字判定）不计入；
    // 判定不足时回退全包围盒（逐人 MODEL_CALIB 仍生效）。
    measureBody(sp, opId, variant, data) {
      const mkey = `${opId}|${variant}`;
      const cached = this.measureBy.get(mkey);
      if (cached) return cached;
      let res;
      try {
        const skel = sp.skeleton;
        // 以 Idle 剪辑首帧姿势测量（借鉴 Stronghold clipBounds：setup 姿势从不出现在屏幕上，且部分模型
        // setup 姿势零件摊开，会把包围盒/中心带偏——如 mudrock 摊开 1400 单位宽）。姿势仅用于测量，
        // 动画状态机随后正常接管。
        try {
          const roles = this.rolesFor(opId, variant, data, 0);
          const anim = roles && roles.idle && data.findAnimation ? data.findAnimation(roles.idle) : null;
          if (anim && typeof anim.apply === "function") anim.apply(skel, 0, 0, false, null, 1, 0, 0);
        } catch { /* 保持 setup 姿势 */ }
        if (skel && typeof skel.updateWorldTransform === "function") skel.updateWorldTransform();
        const skinNames = new Map();      // slotIndex -> [attachment 名]
        for (const skin of (data && data.skins) || []) {
          let list = [];
          try {
            list = (typeof skin.getAttachments === "function" ? skin.getAttachments() : skin.attachments) || [];
          } catch { list = []; }
          for (const e of list) {
            if (!e) continue;
            const idx = typeof e.slotIndex === "number" ? e.slotIndex : (e.slot && e.slot.index);
            if (idx == null) continue;
            const arr = skinNames.get(idx) || [];
            arr.push(e.name || (e.attachment && e.attachment.name) || "");
            skinNames.set(idx, arr);
          }
        }
        const isNonBody = (slot, att) => {
          if ([slot.data && slot.data.name, att && att.name].some((n) => n && BODY_EXCLUDE_RE.test(n))) return true;
          // 该 slot 的全部 skin attachment 都是非身体件才整槽剔除；混合槽保守保留（无法判定）
          const list = skinNames.get(slot.data && slot.data.index);
          return !!(list && list.length && list.every((n) => n && BODY_EXCLUDE_RE.test(n)));
        };
        const growRect = (r, x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (x < r[0]) r[0] = x;
          if (y < r[1]) r[1] = y;
          if (x > r[2]) r[2] = x;
          if (y > r[3]) r[3] = y;
        };
        const poseRect = (bodyOnly) => {
          const r = [Infinity, Infinity, -Infinity, -Infinity];
          const buf = { v: null };
          for (const slot of (skel && skel.drawOrder) || []) {
            const bone = slot.bone;
            if (!bone || bone.active === false) continue;
            const att = slot.getAttachment ? slot.getAttachment() : slot.attachment;
            if (!att || (slot.color ? slot.color.a : 1) * (att.color ? att.color.a : 1) <= 0.004) continue;
            if (bodyOnly && isNonBody(slot, att)) continue;
            const type = att.type;      // pixi-spine AttachmentType：0 Region / 2 Mesh（其余不绘制，跳过）
            if (type === 2 && typeof att.computeWorldVertices === "function") {
              const n = att.worldVerticesLength | 0;
              if (n < 2) continue;
              if (!buf.v || buf.v.length < n) buf.v = new Float32Array(n);
              const v = buf.v;
              att.computeWorldVertices(slot, 0, n, v, 0, 2);
              for (let k = 0; k < n; k += 2) growRect(r, v[k], v[k + 1]);
            } else if (type === 0 && bone.matrix && Number.isFinite(att.width) && Number.isFinite(att.height)) {
              const m = bone.matrix;
              const hw = (att.width * (att.scaleX == null ? 1 : att.scaleX)) / 2;
              const hh = (att.height * (att.scaleY == null ? 1 : att.scaleY)) / 2;
              const rad = ((att.rotation || 0) * Math.PI) / 180, c = Math.cos(rad), s2 = Math.sin(rad);
              for (let q = 0; q < 4; q += 1) {
                const px = q === 0 || q === 3 ? -hw : hw, py = q < 2 ? -hh : hh;
                const lx = px * c - py * s2 + (att.x || 0), ly = px * s2 + py * c + (att.y || 0);
                growRect(r, m.a * lx + m.c * ly + m.tx, m.b * lx + m.d * ly + m.ty);
              }
            }
          }
          return r;
        };
        const full = poseRect(false);
        const body = poseRect(true);
        const rectOk = (r) => r[0] <= r[2] && r[1] <= r[3] && (r[2] - r[0]) > 2 && (r[3] - r[1]) > 2;
        const okBody = rectOk(body) && rectOk(full) && (body[3] - body[1]) >= (full[3] - full[1]) * 0.3;
        const r = okBody ? body : full;
        if (!rectOk(r)) throw new Error("bounds 不可用");
        res = { ok: okBody, x: r[0], y: r[1], w: Math.max(r[2] - r[0], 1), h: Math.max(r[3] - r[1], 1) };
      } catch {
        res = { ok: false, x: 0, y: 0, w: 1, h: 120 };
      }
      this.measureBy.set(mkey, res);
      return res;
    },

    // 建一个变体骨架实例：pivot 按该变体身体包围盒脚底中心重测对齐（换模后脚点/比例口径不变）
    buildSpine(opId, variant, data) {
      const sp = new PIXI.spine38.Spine(data);
      const m = this.measureBody(sp, opId, variant, data);
      sp.pivot.set(m.x + m.w / 2, m.y + m.h);
      sp.__m = m;
      return sp;
    },

    disposeActor(actor) {
      const drop = (sp) => {
        if (!sp) return;
        try { this.app.stage.removeChild(sp); } catch { /* 忽略 */ }
        try { sp.destroy({ children: true }); } catch { /* 忽略 */ }
      };
      drop(actor.spine);
      for (const f of actor.fading || []) drop(f.spine);
      actor.fading = [];
    },

    // 朝向（+1 右 / -1 左）——「朝向→变体选择」唯一接线点：接 facing 字段并按**当前相机投影**取横向展示方向
    // （不直接读 world facing.x：红方/视角变化时同一世界朝向的屏幕左右不同）。变体/镜像规则（动画规范 §朝向）：
    // **明显背向观者**（投影 dy<0 且 |dy|≥|dx|，即走上行/远离相机）→ back 背影骨架；其余（右/左/朝向观者）
    // 一律 front 前向骨架，左行 = scale.x 镜像——双方单位都以“脸可见”呈现，红方行进不再倒走。
    facingOf(unit, actor, now, cam) {
      const f = unit && unit.facing;
      const rec = unit && facingLocal.get(unit.id);   // 前端先行镜像（同一 facing 语义；快照回传后以 unit.facing 为准）
      const vec = f && (f.x || f.y) ? f : (rec && (rec.x || rec.y) ? rec : null);
      if (vec) {
        if (cam) {
          const z = heightAt(Math.round(unit.x), Math.round(unit.y));
          const a = cam.project(unit.x, unit.y, z);
          const b = cam.project(unit.x + vec.x, unit.y + vec.y, z);
          const dx = b.x - a.x, dy = b.y - a.y;
          if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) {
            actor.faceAway = dy < 0 && Math.abs(dy) >= Math.abs(dx);   // 明显背向观者才用背影骨架
            if (Math.abs(dx) > 1e-3) {
              const v = dx > 0 ? 1 : -1;
              actor.facing = v;                       // 记录最近一次实际展示方向（近纵向时沿用）
              actor.facingSince = now;
            }
            return (actor && actor.facing) || (unit.team === "blue" ? 1 : -1);
          }
        } else if (vec.x) {
          actor.faceAway = false;
          return vec.x > 0 ? 1 : -1;
        }
        return (actor && actor.facing) || (unit.team === "blue" ? 1 : -1);   // 屏幕上近纵向：保持现方向
      }
      let facing = unit.team === "blue" ? 1 : -1;
      if (actor && actor.spine) {
        actor.faceAway = false;
        const dx = unit.x - (actor.lastX != null ? actor.lastX : unit.x);
        actor.lastX = unit.x;
        actor.moveDx = (actor.moveDx || 0) * 0.75 + dx * 0.25;
        if (Math.abs(actor.moveDx) > 0.002) facing = actor.moveDx > 0 ? 1 : -1;
        if (facing !== actor.facing) {
          if (now - (actor.facingSince || 0) > 250) {
            actor.facing = facing;
            actor.facingSince = now;
          }
          facing = actor.facing;
        } else {
          actor.facingSince = now;
        }
      }
      return facing;
    },

    createActor(unit, data, now, variant) {
      const old = this.actors.get(unit.id);
      if (old) this.disposeActor(old);
      try {
        const sp = this.buildSpine(unit.opId, variant, data);
        // pivot 只在创建/换模时按身体包围盒脚底中心对齐一次，此后恒定：动画内 root/translate 位移
        // （干员技能“起飞”等）完整生效，模型可离地升起再落回，绝不逐帧重钉脚底。
        this.app.stage.addChild(sp);
        const roles = this.rolesFor(unit.opId, variant, data, unit.skillIndex || 0);
        const actor = {
          spine: sp, opId: unit.opId, variant, data, roles, unit,
          anim: null, animLoop: true, fading: [],
          modelHeight: Math.max(sp.__m.h, 1),
          hpPrev: unit.hp,
          interval: 1.6,
          facing: unit.team === "blue" ? 1 : -1, faceAway: false,
          speed: 0, lastPos: { x: unit.x, y: unit.y },
          facingSince: now, lastX: unit.x, moveDx: 0, fadeUntil: 0,
          sm: {
            mode: "base", base: "idle", baseShown: null, skillOn: !!unit.skillActive,
            skillClipOnce: false, skillEndPending: false,
            skillBeginUntil: 0, skillEndUntil: 0, deployUntil: 0, dieUntil: 0, hitUntil: 0,
            actKind: null, actUntil: 0,           // 一次性动作（attack/heal）窗口：短动作优先、播完回休止态
            bobPhase: 0, lastNow: now,
          },
        };
        this.actors.set(unit.id, actor);
        // 入场一次性（借鉴 spine.js deploy）：Start 剪辑 → base
        const dep = roles.deploy;
        if (dep && dep !== roles.idle && this.playClip(actor, dep, false, { mix: 0 })) {
          actor.sm.mode = "deploy";
          actor.sm.deployUntil = now + this.durOf(data, dep) * 1000;
        } else {
          this.playClip(actor, this.baseClipName(actor), true, {});
          actor.sm.baseShown = actor.sm.base;
        }
        return actor;
      } catch {
        this.actors.set(unit.id, { failed: true, opId: unit.opId });
        return null;
      }
    },

    // 前/后骨架换模：80ms 轻量淡切（新旧实例同位交叠，绝不闪断）。动画状态机不中断——
    // 新实例立即续播同名剪辑（两变体动画同源同名）；pivot/比例按新变体重测对齐。
    switchVariant(actor, unit, variant, now) {
      const data = this.modelData.get(`${actor.opId}|${variant}`);
      if (!data || !this.app) return false;
      let sp;
      try {
        sp = this.buildSpine(actor.opId, variant, data);
      } catch {
        return false;
      }
      const old = actor.spine;
      const oldMirror = actor.facing !== (actor.variant === "front" ? 1 : -1);
      sp.position.set(old.position.x, old.position.y);
      sp.zIndex = old.zIndex;
      sp.tint = old.tint;
      sp.alpha = 0;
      this.app.stage.addChild(sp);
      actor.fading.push({ spine: old, until: now + MODEL_FADE_MS,
        mirror: oldMirror, modelHeight: actor.modelHeight });
      actor.spine = sp;
      actor.variant = variant;
      actor.data = data;
      actor.roles = this.rolesFor(actor.opId, variant, data, unit.skillIndex || 0);
      actor.modelHeight = Math.max(sp.__m.h, 1);
      actor.fadeUntil = now + MODEL_FADE_MS;
      const animName = actor.anim;
      const animLoop = actor.animLoop;
      if (!(animName && this.playClip(actor, animName, animLoop, { mix: 0.06 }))) {
        this.playClip(actor, this.baseClipName(actor), true, { mix: 0.06 });
        actor.sm.baseShown = actor.sm.base;
      }
      return true;
    },

    async sync(view, cam) {
      if (!view || this.busy || !(await this.ensure())) return;
      this.busy = true;
      this.lastView = view;
      try { this.rescueStalls(); } catch { /* 自愈失败不挡帧 */ }
      try {
        await this.loadBackIndex();
        this.warmup(view);
        const seen = new Set();
        // 1) 缺模型的单位并行发起加载（不 await；屏幕内/新入场优先，完成后的下一帧接入）。
        // 按阵营朝向优先要前/后变体；另一变体低优先级预载（front 同时是后向缺失时的镜像回退源）。
        const missing = [];
        for (const unit of view.units) {
          seen.add(unit.id);
          const actor = this.actors.get(unit.id);
          const want = "front";               // 变体规则（动画规范 §朝向）：前向骨架（脸可见）优先，back 仅明显背向
          const alt = "back";
          if (actor && actor.opId === unit.opId && !actor.failed && actor.variant === want) continue;
          if (this.modelData.has(`${unit.opId}|${want}`)) continue;
          const z = heightAt(Math.round(unit.x), Math.round(unit.y));
          const foot = cam.project(unit.x, unit.y, z);
          const onScreen = foot.x > -80 && foot.x < canvas.width + 80 && foot.y > -80 && foot.y < canvas.height + 80;
          missing.push({ unit, pri: onScreen ? 10 : 5, want, alt });
        }
        missing.sort((a, b) => b.pri - a.pri);
        for (const m of missing) {
          this.request(m.unit.opId, m.pri, m.want);
          this.request(m.unit.opId, Math.max(1, m.pri - 4), m.alt);
        }
        // 2) 就绪模型同步建 actor + 每帧变换/动画状态机（零 await，热帧无微任务抖动）
        const now = performance.now();
        const hpEv = this.scanHpEvents(view);   // 快照 HP 差分：真实治疗/命中事件（状态机唯一事件源）
        for (const unit of view.units) {
          let actor = this.actors.get(unit.id);
          const stale = this.staleOps.has(unit.opId);
          if (!actor || actor.opId !== unit.opId || actor.failed || stale) {
            // 目标朝向变体优先；未就绪则用另一变体先上（后向缺失 → 前向镜像回退），就绪后淡切换模。
            // reload 的 stale actor 在新资源未到前继续用旧模型正常驱动（绝不冻结/闪断）。
            let variant = "front";          // 前向骨架优先（脸可见，动画规范 §朝向）；未就绪时 back 先顶替
            let data = this.modelData.get(`${unit.opId}|${variant}`);
            if (!data) {
              variant = "back";
              data = this.modelData.get(`${unit.opId}|${variant}`);
            }
            if (data) {
              actor = this.createActor(unit, data, now, variant);
              this.staleOps.delete(unit.opId);
            }
            if (!actor || actor.failed || !actor.spine || actor.opId !== unit.opId) continue;
          }
          if (actor.failed || !actor.spine) continue;
          // 换模：按投影朝向取变体（明显背向观者=背影骨架，其余前向+镜像）；就绪即 80ms 淡切换模（不闪断）。
          // 仅休止态换模：技能/攻击期换模重测 pivot 会丢剪辑 root 位移（“起飞”滞空），飞行口径见 动画规范
          const facing = this.facingOf(unit, actor, now, cam);
          const want = actor.faceAway ? "back" : "front";
          if (actor.variant !== want && actor.sm.mode === "base" && !unit.stunned
            && this.modelData.has(`${unit.opId}|${want}`)) {
            this.switchVariant(actor, unit, want, now);
          }
          const sp = actor.spine;
          const sm = actor.sm;
          actor.unit = unit;
          const dt = Math.max(0, Math.min(0.1, (now - sm.lastNow) / 1000));
          sm.lastNow = now;
          // 实测移速（格/秒，按“位移帧间隔”计，EMA 平滑）：行进判定/步态 timeScale 的数据源（动画规范 §行进）
          const mv = Math.hypot(unit.x - actor.lastPos.x, unit.y - actor.lastPos.y);
          actor.lastPos.x = unit.x;
          actor.lastPos.y = unit.y;
          if (mv > 1e-4) {
            if (actor.lastMoveAt) {
              const v = mv / Math.max(0.016, (now - actor.lastMoveAt) / 1000);
              actor.speed = actor.speed * 0.5 + v * 0.5;
            }
            actor.lastMoveAt = now;
          } else if (actor.lastMoveAt && now - actor.lastMoveAt > 180) {
            actor.speed = 0;                  // 停步即停：位移消失即速度归零
          }
          // 眩晕冻结（sim stunned）：姿态定格停钟，解除即恢复——不改坐标/比例
          if (unit.stunned) {
            if (!sm.frozen) {
              sm.frozen = true;
              try { if (sp.state) sp.state.timeScale = 0; } catch { /* 模型异常不挡帧 */ }
            }
            const fz = heightAt(Math.round(unit.x), Math.round(unit.y));
            const fp = cam.project(unit.x, unit.y, fz);
            sp.position.set(fp.x, fp.y);
            sp.zIndex = Math.round(-fp.depth);
            continue;
          }
          if (sm.frozen) {
            sm.frozen = false;
            try { if (sp.state) sp.state.timeScale = 1; } catch { /* 模型异常不挡帧 */ }
          }
          const z = heightAt(Math.round(unit.x), Math.round(unit.y));
          const foot = cam.project(unit.x, unit.y, z);
          const op = operator(unit.opId);
          const sk = (op.skills && op.skills[unit.skillIndex || 0]) || op.skill;
          // 攻速匹配：攻击剪辑 timeScale = 剪辑时长/攻击间隔（借鉴 ASSETS.md “timeScale = duration /
          // attackInterval”）；技能期攻速与 sim.js 同源（官方 aspdBonus 优先，buff 技能 0.6×）
          const aspdK = unit.skillActive && sk
            ? (sk.aspdBonus != null ? 100 / (100 + sk.aspdBonus) : (sk.effect === "buff" ? 0.6 : 1))
            : 1;
          actor.interval = Math.max(0.25, (op.aspd || 1.6) * aspdK);
          // 行进判定=实测移速（>0.05 格/秒 → walk，停步即停回待机，动画规范 §行进）；
          // 医疗不在此进攻击循环（治疗动作只由真实治疗事件驱动，见下一节——用户反馈“没人要奶也在奶”）
          const moving = actor.speed > 0.05 && !unit.blockedBy && !unit.skillActive;
          sm.base = moving ? "move" : "idle";
          // 步态 timeScale ≈ 实测速度/常态移速（基准=op.speed；动画规范 §行进）
          const walkTs = sm.base === "move"
            ? Math.min(2.2, Math.max(0.4, actor.speed / (op.speed || 1.5)))
            : 1;

          // 受击反应（轻量：HP 下降边沿触发一次，tint 闪烁 + 可选 Hit 剪辑走独立轨道，不打断主状态）
          if (actor.hpPrev != null && unit.hp < actor.hpPrev - 0.5) {
            sm.hitUntil = now + 130;
            try { sp.tint = 0xff9a9a; } catch { /* 忽略 */ }
            if (actor.roles.hit) {
              try { sp.state.setAnimation(1, actor.roles.hit, false); } catch { /* 忽略 */ }
            }
          }
          actor.hpPrev = unit.hp;
          if (sm.hitUntil && now >= sm.hitUntil) {
            sm.hitUntil = 0;
            try { sp.tint = 0xffffff; } catch { /* 忽略 */ }
          }

          // 技能一次性动作（skillActive 边沿；瞬发技能剪辑播完再收）
          this.setSkill(actor, !!unit.skillActive, now);

          // 限时模式推进（入场 / 技能 Begin / 技能 End）
          if (sm.mode === "deploy" && now >= sm.deployUntil) {
            sm.mode = "base";
            this.playClip(actor, this.baseClipName(actor), true, { mix: 0.15 });
            sm.baseShown = sm.base;
          }
          if (sm.mode === "skillBegin" && now >= sm.skillBeginUntil) {
            const skc = actor.roles.skill;
            const once = sm.skillClipOnce;
            const pending = sm.skillEndPending;
            sm.skillClipOnce = false;
            sm.skillEndPending = false;
            if (pending && skc && skc.end) {
              sm.mode = "skillEnd";
              this.playClip(actor, skc.end, false, { mix: 0.08 });
              sm.skillEndUntil = now + this.durOf(actor.data, skc.end) * 1000;
            } else if (once || pending || !(skc && skc.loop)) {
              sm.mode = "base";
              this.playClip(actor, this.baseClipName(actor), true, { mix: 0.15 });
              sm.baseShown = sm.base;
            } else {
              sm.mode = sm.skillOn ? "skillLoop" : "base";   // Begin 后 loop 已排队，无需重播
            }
          }
          if (sm.mode === "skillEnd" && now >= sm.skillEndUntil) {
            sm.mode = "base";
            this.playClip(actor, this.baseClipName(actor), true, { mix: 0.15 });
            sm.baseShown = sm.base;
          }

          // 一次性动作窗口到期 → 回休止态（短动作优先、不打断长动作，动画规范 §状态机）
          if (sm.mode === "act" && now >= sm.actUntil) {
            sm.mode = "base";
            sm.actKind = null;
            this.playClip(actor, this.baseClipName(actor), true, { timeScale: walkTs, mix: 0.15 });
            sm.baseShown = sm.base;
          }

          // 普攻/治疗动作（动画规范 §状态机）：
          // 循环态——非医疗干员接敌/被阻挡（engaged|blocked）时攻击剪辑按攻速循环（timeScale=剪辑时长/攻击间隔）；
          // 一次性——命中事件（HP 下降，归属最近攻击者）→ attack 播一次回休止态；真实治疗事件（HP 上升）→
          // 医疗干员 heal 播一次（无 Heal 剪辑以 attack=治疗施法剪辑过渡）。**无可奶目标绝不空播**（用户反馈）。
          const attack = actor.roles.attack;
          const isMedic = op.role === "医疗";
          const combatLoop = !isMedic && !unit.skillActive
            && (unit.stopReason === "engaged" || unit.stopReason === "blocked");
          if (sm.mode === "attack" && (!combatLoop || unit.skillActive)) {
            sm.mode = "base";
            if (attack && attack.end) {
              this.playClip(actor, attack.end, false, { mix: 0.1 });
              this.queueClip(actor, this.baseClipName(actor), true, walkTs);
            } else {
              this.playClip(actor, this.baseClipName(actor), true, { timeScale: walkTs, mix: 0.15 });
            }
            sm.baseShown = sm.base;
          } else if (sm.mode === "base" && combatLoop && attack && attack.loop) {
            sm.mode = "attack";
            const loopDur = this.durOf(actor.data, attack.loop);
            const ts = Math.min(4, Math.max(0.35, loopDur / actor.interval));
            if (attack.begin && actor.anim !== attack.loop) {
              this.playClip(actor, attack.begin, false, { mix: 0.06 });
              this.queueClip(actor, attack.loop, true, ts);
            } else {
              this.playClip(actor, attack.loop, true, { timeScale: ts, mix: 0.1 });
            }
          } else if (sm.mode === "base") {
            // 事件驱动一次性动作（真实治疗优先于命中；无事件不盲播）。
            // 治疗归属不再套「医疗↔受治者 ≤4.2 格」的近似：医疗是唯一会产出同队 HP 上升的兵种，
            // 且 sim 已用官方治疗格判定目标（lowestRatioAlly），前端再叠一层距离只会漏判
            // （实测 4.2 格外的合法治疗被丢弃 → act=heal 永不触发）。改为认「本单位造成/参与的上升事件」：
            // 同队 HP 上升 且 医疗处于 healing/engaged（sim 侧真实治疗状态）即播，绝不空播。
            const healEv = isMedic && !unit.skillActive
              && (unit.stopReason === "healing" || unit.stopReason === "engaged")
              && hpEv.heals.some((h) => h.team === unit.team);
            const strikeEv = hpEv.strikes.some((s) => s.id === unit.id);
            if (healEv) this.beginAction(actor, "heal", now);
            else if (strikeEv) this.beginAction(actor, "attack", now);
          }

          // 休止态切换（Idle/Move）；无 Move 剪辑（官方战斗模型基本不走路，盘点 4/464）时以轻微起伏补制行进感；
          // 飞行/滞空单位（unitAirborne：常驻飞行或 leap 技能期）不补起伏，root 位移由剪辑承载（动画规范 §飞行）
          let bobY = 0;
          const hasMove = actor.roles.move && actor.roles.move.loop;
          if (sm.base === "move" && !hasMove && !unitAirborne(unit)) {
            sm.bobPhase += dt * 7.5 * Math.max(0.5, actor.speed / (op.speed || 1.5));
            bobY = Math.sin(sm.bobPhase) * 0.035 * foot.s;
          } else {
            sm.bobPhase = 0;
          }
          sm.bobY = bobY;   // 探针诊断：程序化行进起伏当前位移（有 Move 剪辑/滞空时为 0）
          if (sm.mode === "base" && sm.base !== sm.baseShown) {
            sm.baseShown = sm.base;
            this.playClip(actor, this.baseClipName(actor), true, { timeScale: walkTs, mix: 0.15 });
          }

          sp.position.set(foot.x, foot.y + bobY);
          const natural = actor.variant === "front" ? 1 : -1;     // 前向骨架天然朝右、后向骨架天然朝左
          const mirror = facing !== natural;                      // 仅变体与朝向不符时镜像（front-only 回退）
          const calib = MODEL_CALIB[unit.opId] || 1;             // 逐干员比例校准（优先级最高）
          const scale = (MODEL_TILES * calib * foot.s) / actor.modelHeight;
          sp.scale.set(scale * (mirror ? -1 : 1), scale);
          sp.zIndex = Math.round(-foot.depth);                    // 纵深遮挡
          // 淡切中的新旧实例：同位同缩放跟随，80ms 内新实例 0→1、旧实例 1→0（不闪断）
          if (actor.fadeUntil) {
            sp.alpha = now >= actor.fadeUntil ? 1 : 1 - (actor.fadeUntil - now) / MODEL_FADE_MS;
            if (now >= actor.fadeUntil) actor.fadeUntil = 0;
          }
          for (const f of actor.fading) {
            const fs = (MODEL_TILES * calib * foot.s) / f.modelHeight;
            f.spine.position.set(foot.x, foot.y + bobY);
            f.spine.scale.set(fs * (f.mirror ? -1 : 1), fs);
            f.spine.zIndex = sp.zIndex;
            f.spine.alpha = Math.max(0, Math.min(1, (f.until - now) / MODEL_FADE_MS));
          }
        }
        // 淡切收尾：过期旧实例移出舞台并释放显存（新实例保留为活跃 actor.spine）
        for (const a of this.actors.values()) {
          if (!a.fading || !a.fading.length) continue;
          a.fading = a.fading.filter((f) => {
            if (now >= f.until) {
              try { this.app.stage.removeChild(f.spine); f.spine.destroy({ children: true }); } catch { /* 忽略 */ }
              return false;
            }
            return true;
          });
        }
        // 3) 离场单位：按快照 exits.reason 分派（动画规范 §离场）——death=死亡剪辑一次性；
        // breach（破门=返回手牌）/retreat/skillExit=撤退收势快淡出——破门≠阵亡，绝不播死亡动作（均不重播）。
        // 口径要点：快照 exits 是「消费即清」的边沿事件，若本帧 sync 因 busy/丢帧错过该事件，
        // 单位会直接消失且**查不到 reason**——此时绝不能默认按阵亡播死亡剪辑（用户明确要求破门≠阵亡）。
        // 故只有**确证 death** 才播死亡剪辑；reason 缺失/未知一律走撤退收势（保守侧），避免误播倒地。
        const exits = (view && view.exits) || [];
        // 离场原因在事件帧内一次性留存，供丢帧后的补判（按 unitId 缓存，节流淘汰）
        this.exitMemo = this.exitMemo || new Map();
        for (const e of exits) if (e && e.id) this.exitMemo.set(e.id, e.reason);
        if (this.exitMemo.size > 256) {
          for (const k of [...this.exitMemo.keys()].slice(0, this.exitMemo.size - 256)) this.exitMemo.delete(k);
        }
        for (const [id, actor] of this.actors) {
          if (seen.has(id)) continue;
          if (!actor.spine || !actor.sm) { this.disposeActor(actor); this.actors.delete(id); continue; }
          if (actor.sm.mode !== "die") {
            const exit = exits.find((e) => e.id === id);
            const reason = (exit && exit.reason) || this.exitMemo.get(id) || null;
            if (reason === "death") this.beginDie(actor, now);
            else this.beginRetreat(actor, now);      // breach/retreat/skillExit/未知 → 撤退收势（绝不误播阵亡）
            this.exitMemo.delete(id);
          } else if (now >= actor.sm.dieUntil) {
            this.disposeActor(actor);
            this.actors.delete(id);
          } else {
            const left = actor.sm.dieUntil - now;
            actor.spine.alpha = Math.max(0, Math.min(1, left / (actor.sm.fadeTail || 500)));
          }
        }
      } finally {
        this.busy = false;
      }
    },

    has(unitId) {
      const a = this.actors.get(unitId);
      return !!(a && a.spine);
    },

    // 保险自愈：单位出现 2.5s 后仍无模型（失败/丢挂）→ 清失效缓存并重载（每 opId 10 秒最多一次；不改战斗状态）
    rescueStalls() {
      const now = performance.now();
      this._seenAt = this._seenAt || new Map();
      this._rescue = this._rescue || new Map();
      for (const unit of (this.lastView && this.lastView.units) || []) {
        if (this.has(unit.id)) { this._seenAt.delete(unit.id); continue; }
        if (!this._seenAt.has(unit.id)) { this._seenAt.set(unit.id, now); continue; }
        if (now - this._seenAt.get(unit.id) < 2500) continue;
        const last = this._rescue.get(unit.opId) || 0;
        if (now - last > 10000) {
          this._rescue.set(unit.opId, now);
          this.logEvent({ event: "model-rescue", ok: true, opId: unit.opId });
          try { this.reload(unit.opId); } catch { /* 忽略 */ }
        }
      }
    },

    // ---- 失效缓存清除 + 资源重载（不刷新页面恢复） ----
    // 只动 spineLayer 的资源缓存/失败条目/显示 actor，绝不触碰 sim/state 等内部战斗状态。
    // reload 后单位在下一帧自动用新资源重建 actor（占位 → 模型无缝替换）。
    reload(opId) {
      const prefix = `${opId}|`;
      let cleared = 0;
      for (const map of [this.models, this.modelData, this.modelMeta, this.measureBy, this.animPick, this.failures]) {
        for (const key of [...map.keys()]) {
          if (key.startsWith(prefix)) { map.delete(key); cleared += 1; }
        }
      }
      const dir = `assets/spine/${opId}/`;
      for (const base of [...this.atlases.keys()]) if (base.startsWith(dir)) this.atlases.delete(base);
      for (const base of [...this.skels.keys()]) if (base.startsWith(dir)) this.skels.delete(base);
      this.staleOps.add(opId);
      this.logEvent({ event: "cache-invalidate", ok: true, opId, cleared });
      this.request(opId, 10, "front");
      this.request(opId, 10, "back");
      return { opId, cleared };
    },

    reloadAll() {
      this.models.clear();
      this.modelData.clear();
      this.modelMeta.clear();
      this.measureBy.clear();
      this.animPick.clear();
      this.failures.clear();
      this.atlases.clear();
      this.skels.clear();
      for (const a of this.actors.values()) if (a.opId) this.staleOps.add(a.opId);
      this.logEvent({ event: "cache-invalidate", ok: true, opId: "*" });
      return { all: true };
    },
  };
  // 测试/调试探针（单位层测量/动画状态机/加载诊断；reload* 为恢复入口，不参与玩法、不改战斗状态）
  window.__SPINE_DEBUG__ = {
    measures: () => Object.fromEntries(spineLayer.measureBy),
    roles: () => Object.fromEntries(spineLayer.animPick),
    actors: () => {
      const o = {};
      for (const [id, a] of spineLayer.actors) {
        if (!a.spine) { o[id] = { failed: true, opId: a.opId }; continue; }
        const b = a.spine.getBounds();
        const natural = a.variant === "front" ? 1 : -1;
        o[id] = {
          opId: a.opId, anim: a.anim, mode: a.sm.mode, base: a.sm.base,
          act: a.sm.actKind, speed: +(a.speed || 0).toFixed(2),
          team: (a.unit && a.unit.team) || null,
          skillOn: a.sm.skillOn, modelHeight: +a.modelHeight.toFixed(1),
          variant: a.variant, facing: a.facing, faceAway: !!a.faceAway,
          source: a.variant === "back" ? "back-model" : (a.facing < 0 ? "front-mirrored" : "front-model"),
          mirror: a.facing !== natural,
          // 飞行/滞空 + 步态编排诊断（动画规范 §飞行）：airborne 取 unitAirborne（常驻飞行或 leap 技能期）；
          // moveClip=是否有真实 Move 剪辑（无则程序化起伏）；bob=当前起伏像素（探针据此断言行进补制生效）
          airborne: !!(a.unit && unitAirborne(a.unit)),
          moveClip: !!(a.roles && a.roles.move && a.roles.move.loop) || false,
          bob: +(a.sm && a.sm.bobY ? a.sm.bobY : 0).toFixed(2),
          moveAnim: a.sm && a.sm.base === "move" ? a.anim : null,
          pos: [+a.spine.position.x.toFixed(1), +a.spine.position.y.toFixed(1)],
          scale: +a.spine.scale.y.toFixed(4),
          world: [+b.x.toFixed(1), +b.y.toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)],
        };
      }
      return o;
    },
    models: () => [...spineLayer.modelData.keys()],
    meta: (key) => spineLayer.modelMeta.get(key) || null,
    // 单变体测量探针（临时实例测量后销毁；换模前后比例/脚点对齐核对用）
    measureOf: (opId, variant = "front") => {
      const data = spineLayer.modelData.get(`${opId}|${variant}`);
      if (!data) return null;
      let sp = null;
      try {
        sp = new PIXI.spine38.Spine(data);
        return { ...spineLayer.measureBody(sp, opId, variant, data) };
      } catch (e) {
        return { error: String(e) };
      } finally {
        if (sp && sp.destroy) { try { sp.destroy({ children: true }); } catch { /* 忽略 */ } }
      }
    },
    failures: () => Object.fromEntries(spineLayer.failures),
    log: (n = 60) => spineLayer.loadLog.slice(-n),
    backCoverage: () => {
      const ent = (spineLayer.backIndex && spineLayer.backIndex.entries) || {};
      const counts = {};
      for (const e of Object.values(ent)) counts[e.kind] = (counts[e.kind] || 0) + 1;
      return { counts, total: Object.keys(ent).length };
    },
    reload: (opId) => spineLayer.reload(opId),
    reloadAll: () => spineLayer.reloadAll(),
  };

  // 画布自适应：内部尺寸 = CSS 尺寸（不拉伸），投影 viewport 同步
  function resizeBoards() {
    const stack = document.querySelector(".boardStack");
    if (!stack || state.screen !== "battle") return;
    const r = stack.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    const w = Math.round(r.width), h = Math.round(r.height);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      PROJ.setViewport(w, h);
    }
    if (unitCanvas.width !== w || unitCanvas.height !== h) {
      unitCanvas.width = w;
      unitCanvas.height = h;
      if (spineLayer.app && spineLayer.app.renderer) spineLayer.app.renderer.resize(w, h);
    }
    if (fxCanvas.width !== w || fxCanvas.height !== h) {
      fxCanvas.width = w;
      fxCanvas.height = h;
    }
    if (occCanvas && (occCanvas.width !== w || occCanvas.height !== h)) {
      occCanvas.width = w;
      occCanvas.height = h;
    }
  }
  window.addEventListener("resize", resizeBoards);

  // ---------------- 小地图（地形/门/阵营/单位/视野框；单击定位 vs 拖框平移；pan 限幅=真实视野不出地图） ----------------
  // 方位约定：小地图恒为世界方位（x→右、y→下）——与「视角不改变世界朝向」一致：红方/俯视/斜视均不镜像，
  // 视野框由真实相机反投影（红方视角下门/单位/视野框方位正确）；点击/拖框经同一世界坐标换算，不改服务器坐标。
  const miniWrap = document.querySelector("#miniWrap");
  const miniCanvas = document.querySelector("#miniMap");
  const mctx = miniCanvas ? miniCanvas.getContext("2d") : null;
  let miniDrag = null;   // { x0, y0, start, grab, moved }：按下只记录，超过阈值才算拖框
  function rawViewRect(cam) {
    // 真实视野范围（世界坐标、未 clamp）：屏幕四角反投影到地面
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const area = cam.viewport || { x: 0, y: 0, width: canvas.width, height: canvas.height };
    for (const [px, py] of [[area.x, area.y], [area.x + area.width, area.y], [area.x, area.y + area.height], [area.x + area.width, area.y + area.height]]) {
      const q = cam.unproject(px, py, 0);
      if (!q) continue;
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
      y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
    }
    return { x0, y0, x1, y1 };
  }
  function visibleGroundRect(cam, m) {
    // 视野框=屏幕四角反投影到地面的实际可见范围（clamp 在地图内）；缩放/视角变化自动一致
    const r = rawViewRect(cam);
    return {
      x0: Math.max(0, Math.min(m.width - 1, r.x0)), x1: Math.max(1, Math.min(m.width, r.x1)),
      y0: Math.max(0, Math.min(m.height - 1, r.y0)), y1: Math.max(1, Math.min(m.height, r.y1)),
    };
  }
  function panLimits(m) {
    // pan 限幅＝按真实视野范围（不是简单 ±整图）：pan=0 的视野范围平移 pan 后仍须落在地图内；
    // 视野宽/高于地图时锁定居中（整图已可见=无需平移）。红方视角同样成立（世界坐标判定，与镜头朝向无关）。
    const r = rawViewRect(battleCam());
    const pan = state.pan || { x: 0, y: 0 };
    const x0 = r.x0 - pan.x, x1 = r.x1 - pan.x, y0 = r.y0 - pan.y, y1 = r.y1 - pan.y;
    const lim = { x0: -x0, x1: m.width - x1, y0: -y0, y1: m.height - y1 };
    if (x1 - x0 >= m.width) lim.x0 = lim.x1 = (m.width - (x1 - x0)) / 2 - x0;
    if (y1 - y0 >= m.height) lim.y0 = lim.y1 = (m.height - (y1 - y0)) / 2 - y0;
    return {
      x0: Math.min(lim.x0, lim.x1), x1: Math.max(lim.x0, lim.x1),
      y0: Math.min(lim.y0, lim.y1), y1: Math.max(lim.y0, lim.y1),
    };
  }
  function setPan(px, py) {
    const lim = panLimits(currentMap());
    state.pan = {
      x: Math.max(lim.x0, Math.min(lim.x1, px)),
      y: Math.max(lim.y0, Math.min(lim.y1, py)),
    };
    miniRefreshAt = 0;   // 视野框实时跟随（平移/视角切换后立即重绘，不等节流）
  }
  function panTo(wx, wy) {
    // 单击定位=该处成为视野中心。格中心口径统一（相机目标=(w-1)/2,(h-1)/2；不与 raw AABB 中心/map.w-2 混用半格偏移）
    const m = currentMap();
    setPan(wx - (m.width - 1) / 2, wy - (m.height - 1) / 2);
  }
  // ---------------- 地图环境动画（引擎：public/map-animations.js） ----------------
  // 地图配置的 animations 字段（sakura_petals / ink_mist / tech_grid）驱动原版动画引擎；
  // 换图时重建，粒子上限可由配置 count 覆盖。
  const AMBIENT_ANIM_BY_KIND = {
    sakura_petals: "sakuraPetals",
    ink_mist: "inkMist",
    tech_grid: "techGrid",
  };
  let ambientKey = null;
  function currentMapCfg() {
    const pack = window.AKF_MAPS || {};
    const id = (state.view && state.view.mapId)
      || (state.localBattle && state.localBattle.mapId) || state.mapId;
    return (pack.maps || []).find((mm) => mm.id === id) || null;
  }
  function syncAmbientAnim() {
    if (typeof AnimationManager === "undefined" || typeof MAP_ANIMATIONS === "undefined") return;
    const m = currentMapCfg();
    const defs = (m && Array.isArray(m.animations)) ? m.animations : [];
    const want = [];
    for (const d of defs) {
      const name = AMBIENT_ANIM_BY_KIND[d && d.kind];
      if (!name || !MAP_ANIMATIONS[name]) continue;
      if (Number.isFinite(d.count) && d.count > 0) {
        MAP_ANIMATIONS[name].maxCount = Math.max(1, Math.min(160, Math.round(d.count)));
      }
      want.push(name);
    }
    const key = ((m && m.id) || "-") + "|" + want.join(",");
    if (key === ambientKey) return;
    ambientKey = key;
    AnimationManager.clearAll();
    for (const name of want) AnimationManager.startAnimation(name);
  }
  function initAmbientCanvas() {
    if (typeof AnimationManager === "undefined") return;
    const cv = $("animCanvas");
    if (!cv) return;
    cv.style.position = "absolute";
    cv.style.inset = "0";
    cv.style.pointerEvents = "none";
    AnimationManager.init(cv);
  }

  function drawMiniMap(view) {
    if (!mctx) return;
    const m = currentMap();
    const fits = m.width <= 16 && m.height <= 12;      // 一屏能看全 → 隐藏小地图
    const show = !fits && state.screen === "battle";
    miniWrap.classList.toggle("hidden", !show);
    if (!show) return;
    // 长宽比与地图一致（绘制缓冲随图，CSS 宽固定、高 auto）
    const W = 220, H = Math.max(80, Math.min(360, Math.round(W * m.height / m.width)));
    if (miniCanvas.width !== W || miniCanvas.height !== H) {
      miniCanvas.width = W;
      miniCanvas.height = H;
    }
    const sx = W / m.width, sy = H / m.height;
    const mx = (wx) => (wx + 0.5) * sx, my = (wy) => (wy + 0.5) * sy;   // 世界格中心 → 小图像素
    mctx.fillStyle = "#0c0f13"; mctx.fillRect(0, 0, W, H);
    for (let y = 0; y < m.height; y += 1) {
      for (let x = 0; x < m.width; x += 1) {
        mctx.fillStyle = m.isWall(x, y) ? "#151a22" : m.isHigh(x, y) ? "#8b98ac" : m.isPath(x, y) ? "#4c5a68" : "#2f3740";
        mctx.fillRect(x * sx, y * sy, sx + 0.6, sy + 0.6);
      }
    }
    // 门：菱形+白描边（与地形块/单位圆点明显区分）
    for (const [team, gs] of Object.entries(m.gates || {})) {
      for (const g of gs) {
        const cx = mx(g.x), cy = my(g.y), r = Math.max(3.5, Math.min(sx, sy) * 0.6);
        mctx.beginPath();
        mctx.moveTo(cx, cy - r); mctx.lineTo(cx + r, cy); mctx.lineTo(cx, cy + r); mctx.lineTo(cx - r, cy);
        mctx.closePath();
        mctx.fillStyle = team === "blue" ? "#3fa9ff" : "#e8483c";
        mctx.fill();
        mctx.lineWidth = 1.4;
        mctx.strokeStyle = "#ffffff";
        mctx.stroke();
      }
    }
    if (view) {
      // 单位：阵营色圆点+白描边；选中单位加大+黄环
      for (const u of view.units) {
        const cx = mx(u.x), cy = my(u.y), selUnit = u.id === state.selectedUnitId;
        mctx.beginPath();
        mctx.arc(cx, cy, selUnit ? 4.4 : 3.2, 0, Math.PI * 2);
        mctx.fillStyle = u.team === "blue" ? "#54b8ff" : "#ff5a5a";
        mctx.fill();
        mctx.lineWidth = selUnit ? 1.9 : 1.1;
        mctx.strokeStyle = selUnit ? "#ffd800" : "rgba(255,255,255,.92)";
        mctx.stroke();
      }
    }
    // 当前视野框：半透明填充+亮框（平移/缩放后实时正确）
    const vr = visibleGroundRect(battleCam(), m);
    const rx = mx(vr.x0 - 0.5), ry = my(vr.y0 - 0.5);
    const rw = Math.max(4, (vr.x1 - vr.x0) * sx), rh = Math.max(4, (vr.y1 - vr.y0) * sy);
    mctx.fillStyle = "rgba(255,216,0,.12)";
    mctx.fillRect(rx, ry, rw, rh);
    mctx.strokeStyle = "#ffd800";
    mctx.lineWidth = 2;
    mctx.strokeRect(rx, ry, rw, rh);
    mctx.strokeStyle = "rgba(255,255,255,.28)";
    mctx.lineWidth = 1;
    mctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
  function miniToWorld(e) {
    const r = miniCanvas.getBoundingClientRect();
    const m = currentMap();
    return {
      x: (e.clientX - r.left) * m.width / r.width - 0.5,
      y: (e.clientY - r.top) * m.height / r.height - 0.5,
    };
  }
  if (miniCanvas) {
    miniCanvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // 按下框内：记 startPan + 抓取位置（只记录，不动镜头——避免误跳）
      const w = miniToWorld(e);
      miniDrag = {
        x0: e.clientX, y0: e.clientY, start: w,
        startPan: { x: (state.pan && state.pan.x) || 0, y: (state.pan && state.pan.y) || 0 },
        moved: false,
      };
      try { miniCanvas.setPointerCapture(e.pointerId); } catch { /* 无指针捕获环境回退 window 监听 */ }
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      const d = miniDrag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 6) d.moved = true;   // 拖框阈值
      if (!d.moved) return;
      const w = miniToWorld(e);
      // 拖框= startPan + 鼠标世界位移（抓取偏移保持，不吸附）后按真实视野 clamp（拖出小地图也不飞出地图）
      setPan(d.startPan.x + (w.x - d.start.x), d.startPan.y + (w.y - d.start.y));
    });
    window.addEventListener("mouseup", (e) => {
      const d = miniDrag;
      if (!d) return;
      miniDrag = null;
      try { miniCanvas.releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
      if (!d.moved) { const w = miniToWorld(e); panTo(w.x, w.y); }   // 单击=跳转到该处视野中心（框内外同一算法）；拖框松手不跳镜头
    });
  }

  // ---------------- 帧循环 ----------------
  let uiRefreshAt = 0;
  let miniRefreshAt = 0;   // 小地图 5Hz 节流（4-6Hz 视觉不卡；地形在离屏缓存里，低频重绘无感）
  // 演示/教程模式：战场时钟独立推进，不挂在 rAF 上。
  // rAF 在掉帧、后台标签、无头浏览器里会被暂停或降频，而帧内 dt 又被钳在 0.05s，
  // 时钟就会“停住”。这里按真实经过时间以固定 100ms 步长补步（单次上限 0.5s，避免切回标签时瞬跳）。
  let demoTickAt = 0;
  setInterval(() => {
    if (!state.localBattle || !state.localSim || state.screen !== "battle") { demoTickAt = 0; return; }
    const tickNow = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (!demoTickAt) { demoTickAt = tickNow; return; }
    const step = Math.min(0.5, Math.max(0, (tickNow - demoTickAt) / 1000));
    demoTickAt = tickNow;
    if (step <= 0) return;
    try {
      state.localSim.tick(state.localBattle, step);
      applySnapshot(state.localSim.snapshot(state.localBattle));
      if (state.localBattle.winner && !state.resultShown) showResult(state.view, state.localBattle.winner);
    } catch (demoErr) {
      if (frame._demoErr !== String(demoErr)) { frame._demoErr = String(demoErr); console.error("demo tick error", demoErr); }
    }
  }, 100);
  function frame(now) {
    window.__FRAME_N__ = (window.__FRAME_N__ || 0) + 1;   // 帧活性诊断计数（只读）
    try {
    const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
    frame.last = now;
    frameDt = dt || 1 / 60;
    if (window.AKF_TUTORIAL && window.AKF_TUTORIAL.active && window.AKF_TUTORIAL_HOST) {
      try {
        window.AKF_TUTORIAL.tick(window.AKF_TUTORIAL_HOST);   // 选人/战斗两阶段都要推进（观察真实状态）
      } catch (tutErr) {
        if (!frame._tutErr || frame._tutErr !== String(tutErr)) {
          frame._tutErr = String(tutErr);
          log(`教程推进错误：${tutErr && tutErr.message ? tutErr.message : tutErr}`, "bad");
        }
      }
    }
    if (state.screen === "battle") {
      resizeBoards();
      // 演示/教程的战场时钟由下方固定步长计时器推进（不挂在 rAF 上），这里只负责渲染
      draw();
      const cam = battleCam();
      spineLayer.sync(state.view, cam).catch(() => {});
      if (occCtx) {
        try {
          drawOcclusion(cam, state.view);   // 前景遮挡：更近地块/侧壁盖住台后单位（不拦截输入）
        } catch (occErr) {
          if (!frame._occErr || frame._occErr !== String(occErr)) {
            frame._occErr = String(occErr);
            log(`遮挡层渲染错误：${occErr && occErr.message ? occErr.message : occErr}`, "bad");
          }
        }
      }
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
      if (state.view) {
        try {
          drawFx(fxCtx, cam);
        } catch (fxErr) {
          // 帧循环护栏：单个特效错误不打死渲染；错误显式上报（不吞异常）
          if (!frame._fxErr || frame._fxErr !== String(fxErr)) {
            frame._fxErr = String(fxErr);
            log(`特效渲染错误：${fxErr && fxErr.message ? fxErr.message : fxErr}`, "bad");
          }
        }
        try {
          syncAmbientAnim();                 // 换图时切动画
          AnimationManager.update();         // 原版引擎：粒子推进 + 绘制到 animCanvas
        } catch (ambErr) {
          if (!frame._ambErr || frame._ambErr !== String(ambErr)) {
            frame._ambErr = String(ambErr);
            log(`环境动画渲染错误：${ambErr && ambErr.message ? ambErr.message : ambErr}`, "bad");
          }
        }
      }
      if (now >= miniRefreshAt) {
        drawMiniMap(state.view);          // 节流 5Hz（语义不变：仍按快照刷新地形/单位/视野框）
        miniRefreshAt = now + 200;
      }
      if (now >= uiRefreshAt) {
        renderHand();
        updateUnitInfo();
        syncLogFromView();
        $("blueHp").textContent = state.view ? state.view.gateHp[state.team] : 0;
        $("enemyHp").textContent = state.view ? state.view.gateHp[state.team === "blue" ? "red" : "blue"] : 0;
        $("cost").textContent = state.view ? state.view.cost[state.team] : 0;
        $("timer").textContent = formatTime(state.view ? state.view.elapsed : 0);
        $("teamBadge").textContent = `阵营：${state.team === "blue" ? "蓝方" : "红方"} · ${state.view?.mapName || "十字高台"}（本局随机分配）`;
        uiRefreshAt = now + 100;
      }
    }
    } catch (frameErr) {
      // 帧护栏：单帧错误不得冻结整局（错误显式上报，不吞异常），并保证续帧
      if (!frame._lastErr || frame._lastErr !== String(frameErr)) {
        frame._lastErr = String(frameErr);
        try {
          log(`帧循环错误：${frameErr && frameErr.message ? frameErr.message : frameErr}`, "bad");
          console.error("frame error", frameErr);
        } catch { /* 日志不可用时仍续帧 */ }
      }
    } finally {
      requestAnimationFrame(frame);
    }
  }

  function formatTime(s) {
    const t = Math.max(0, Math.floor(s || 0));
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }

  // ---------------- 快捷键 ----------------
  window.addEventListener("keydown", (e) => {
    if (state.screen !== "battle") return;
    if (e.target.matches?.("input,textarea,select") || e.target.isContentEditable || e.repeat) return;
    if (FACING.handleKey(e)) return;   // 四向选向优先：方向键=候选 / Enter=确认朝向 / Esc=暂时收起
    const key = /^Key[A-Z]$/.test(e.code || "") ? e.code.slice(3).toLowerCase() : String(e.key || "").toLowerCase();
    canvas.dataset.lastControl = `${e.key || ""}:${e.code || ""}`;
    const hand = state.view ? state.view.hand[state.team] : [];
    if (/^[0-9]$/.test(key)) {
      const slot = hand[key === "0" ? 9 : Number(key) - 1];
      if (slot) { selectHandCard(slot.opId); }
      return;
    }
    if (key === "q" || key === "w") {
      const slot = hand[key === "q" ? 10 : 11];
      if (slot) { selectHandCard(slot.opId); }
      return;
    }
    if (e.key === "Enter") { state.enterCount = (state.enterCount || 0) + 1; confirmRoute(); e.preventDefault(); return; }
    if (e.key === " ") { ROUTE.autoRoute(); e.preventDefault(); return; }          // 空格=默认自动寻路（成路并预览，Enter 出发）
    if (key === "h") { ROUTE.toggleAdvanced(); e.preventDefault(); return; }       // H=高级模式开/关
    if (key === "g") { ROUTE.clearAll(); e.preventDefault(); return; }             // G=取消全部已选线
    if (e.key === "ArrowUp") { ROUTE.cycleLine(-1); e.preventDefault(); return; }  // ↑/↓=循环切换候选线路（无上路/下路按钮）
    if (e.key === "ArrowDown") { ROUTE.cycleLine(1); e.preventDefault(); return; }
    if (key === "e") { activateSelectedSkill(); e.preventDefault(); return; }
    if (key === "r") { requestHighMove(); e.preventDefault(); return; }
    if (key === "f") { requestDescend(); e.preventDefault(); return; }
    if (key === "x") { requestRetreat(); e.preventDefault(); return; }
    if (e.key === "Escape") {
      // Esc 分层：先退高级自定义预览（保留模式）→ 再退高级模式 → 最后清选中/面板/跟随手势
      if (ROUTE.advanced && ROUTE.customPath.length > 1) { ROUTE.clearPreview(); e.preventDefault(); return; }
      if (ROUTE.advanced) { ROUTE.toggleAdvanced(false); e.preventDefault(); return; }
      selectBattleUnit(null);
      state.cardDrag = null;
      $("deployDragPreview")?.remove();
      $("battleSettingsPanel").classList.add("hidden");
      state.routeDraft = [];
      state.highTarget = null;
      state.descendTarget = null;
      ROUTE.clearDraft();                     // 清线路预览/自定义路径/拖拽跟随手势
    }
  });

  document.querySelectorAll(".uoTab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.unitTab = tab.dataset.tab || "skill";
      updateUnitInfo();
    });
  });
  $("unitOverlayClose").addEventListener("click", () => {
    selectBattleUnit(null);
  });
  $("highMoveButton").addEventListener("click", requestHighMove);
  $("uoSkillButton").addEventListener("click", activateSelectedSkill);
  $("marchButton").addEventListener("click", confirmRoute);
  const viewPanel = $("battleSettingsPanel");
  $("battleSettingsButton").addEventListener("click", () => {
    const open = viewPanel.classList.toggle("hidden") === false;
    $("battleSettingsButton").setAttribute("aria-expanded", String(open));
  });
  $("closeBattleSettings").addEventListener("click", () => { viewPanel.classList.add("hidden"); $("battleSettingsButton").setAttribute("aria-expanded", "false"); });
  viewPanel.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    state.cameraPreset = b.dataset.view;
    viewPanel.querySelectorAll("[data-view]").forEach((x) => x.classList.toggle("active", x === b));
    try { localStorage.setItem("arkfights-camera", state.cameraPreset); } catch {}
    ROUTE.clearDraft();
    const unit = selectedUnit(); if (unit?.marchAllowed) ROUTE.beginMarch(unit);
  }));
  try { state.cameraPreset = localStorage.getItem("arkfights-camera") || "default"; } catch { state.cameraPreset = "default"; }
  viewPanel.querySelector(`[data-view="${["default", "top", "angled"].includes(state.cameraPreset) ? state.cameraPreset : "default"}"]`)?.classList.add("active");
  $("resetBattleView").addEventListener("click", () => { state.pan = { x: 0, y: 0 }; });

  // ---------------- 下地行动 / 主动撤退（服务器权威；按钮与快照下发的真实状态一致） ----------------
  function requestDescend() {
    const u = selectedUnit();
    if (!u || u.team !== state.team || !operator(u.opId)?.high) return;
    if (u.positionMode !== "high") { log("该单位已在地面行动。", "bad"); return; }
    if (!descendTiles(u).length) { log("没有相邻地面落点，可先搬运至高台边缘", "bad"); return; }
    state.descendTarget = u.id;
    state.highTarget = null;
    log("点击高亮的相邻地面落点；下地后可选择线路，或拖向己方干员建立跟随", "sys");
  }
  function requestRetreat() {
    const u = selectedUnit();
    if (!u || u.team !== state.team || u.retreatable === false) return;
    if (state.localSim && state.localBattle) {
      const rr = state.localSim.applyIntent(state.localBattle, state.team, { kind: "retreat", unitId: u.id });
      if (!rr.ok) log(`撤退被拒绝：${rr.reason}`, "bad");
    }
    if (!state.localBattle) sendIntent({ kind: "retreat", unitId: u.id });
    state.selectedUnitId = null;
  }
  $("descendButton").addEventListener("click", requestDescend);
  $("retreatButton").addEventListener("click", requestRetreat);

  // ---------------- 终端内切换：干员图鉴 / 设置 / 部署教程（保留素材与首页状态） ----------------
  const PREFS_KEY = "arkfights-prefs";
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (p.name) $("nameInput").value = p.name;
      if (p.room) $("roomInput").value = p.room;
      if (p.reduceFx) $("cfgReduceFx").checked = true;
      if (p.homeOperator) {
        const heroImg = document.querySelector(".heroChar");
        if (heroImg) {
          heroImg.src = `assets/art/${p.homeOperator}.webp`;
        }
      }
    } catch { /* 偏好损坏时用默认值 */ }
  }
  function savePrefs() {
    try {
      const homeOpSelect = $("cfgHomeOperator");
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        name: $("nameInput").value, 
        room: $("roomInput").value, 
        reduceFx: $("cfgReduceFx").checked,
        homeOperator: homeOpSelect ? homeOpSelect.value : "silverash_big",
      }));
    } catch { /* 隐私模式等场景忽略 */ }
  }
  loadPrefs();

  $("navRoster").addEventListener("click", () => {
    switchScreen("gallery");
    if (window.AKF_ROSTER && window.AKF_ROSTER.render) {
      // 对战池集合：同时收录 data.js 的 id 与 charId（部分干员 id 为短名，图鉴内以 charId 记录）
      const pool = new Set();
      OPS.forEach((o) => { if (o.id) pool.add(o.id); if (o.charId) pool.add(o.charId); });
      window.AKF_ROSTER.render($("rosterRoot"), { playable: pool });
    } else {
      $("rosterRoot").innerHTML = '<p class="cfgNote">干员图鉴未加载，请刷新页面重试。</p>';
    }
  });
  $("navConfig").addEventListener("click", () => {
    $("cfgName").value = $("nameInput").value;
    $("cfgRoom").value = $("roomInput").value;
    // 加载当前主页干员设置
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (p.homeOperator && $("cfgHomeOperator")) {
        $("cfgHomeOperator").value = p.homeOperator;
      }
    } catch {}
    switchScreen("config");
  });
  $("guideButton").addEventListener("click", () => {
    if (!$("guideBody").childElementCount) {
      fetch("guide.html").then((r) => r.text()).then((t) => {
        const m = t.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        $("guideBody").innerHTML = m ? m[1] : t;
      }).catch(() => { $("guideBody").innerHTML = "<p>教程加载失败。</p>"; });
    }
    switchScreen("guide");
  });
  $("rosterBack").addEventListener("click", () => switchScreen("home"));
  $("guideBack").addEventListener("click", () => switchScreen("home"));
  $("configBack").addEventListener("click", () => {
    $("nameInput").value = $("cfgName").value || $("nameInput").value;
    $("roomInput").value = $("cfgRoom").value || $("roomInput").value;
    // 应用主页干员更改
    const homeOpSelect = $("cfgHomeOperator");
    if (homeOpSelect) {
      const heroImg = document.querySelector(".heroChar");
      if (heroImg) {
        heroImg.src = `assets/art/${homeOpSelect.value}.webp`;
      }
    }
    savePrefs();
    switchScreen("home");
  });
  $("cfgReduceFx").addEventListener("change", savePrefs);
  // 监听主页干员选择变化
  const homeOpSelect = $("cfgHomeOperator");
  if (homeOpSelect) {
    homeOpSelect.addEventListener("change", savePrefs);
  }

  // ---------------- 地图选择/整图预览（真实地图渲染；选择同步服务器与双方） ----------------
  // 地图列表以 maps.js 数据为准动态生成，避免列表与数据不同步
  function mapDef(id) {
    const pack = window.AKF_MAPS || {};
    return (pack.maps || []).find((mm) => mm.id === id) || null;
  }
  function mapNameOf(id) {
    const m = mapDef(id);
    return (m && m.name) || id;
  }
  function renderMapGrid() {
    const grid = document.querySelector(".mapGrid");
    const maps = ((window.AKF_MAPS || {}).maps) || [];
    if (!grid || !maps.length) return;
    grid.innerHTML = maps.map((m) =>
      '<button class="akBtn mapPick" data-map="' + m.id + '">' +
      '<em>' + m.name + '</em>' +
      '<small>' + String(m.id).toUpperCase() + " · " + m.w + "×" + m.h + '</small>' +
      '<u class="mapCheck">✓ 已选</u></button>').join("");
    grid.querySelectorAll(".mapPick").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.previewMapId = btn.dataset.map;
        $("mapPreview").classList.remove("hidden");
        markMapSelection();
        renderMapPreview($("mpCanvas"), btn.dataset.map);
      });
    });
  }
  function markMapSelection() {
    const cur = state.mapId || "cross";
    document.querySelectorAll(".mapPick").forEach((b) => {
      b.classList.toggle("active", b.dataset.map === cur);
      const ck = b.querySelector(".mapCheck");
      if (ck) ck.style.visibility = b.dataset.map === cur ? "visible" : "hidden";
    });
    if ($("mapCurrent")) $("mapCurrent").textContent = `当前：${mapNameOf(cur)} ✓`;
    if ($("mpName")) $("mpName").textContent = `${mapNameOf(cur)} // 整图预览`;
  }
  function renderMapPreview(canvas, mapId) {
    const map = window.AKF_SIM.MAPS[mapId] || window.AKF_SIM.MAPS.cross;
    const g = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    PROJ.setViewport(W, H);
    const cam = PROJ.cameraFor("blue", map.width, map.height);
    g.fillStyle = "#14161b";
    g.fillRect(0, 0, W, H);
    const zAt = (x, y) => (map.isHigh(x, y) ? 1 : 0);
    const tiles = [];
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
      const z = map.isWall(x, y) ? 0.62 : zAt(x, y);
      tiles.push({ x, y, z, depth: cam.project(x, y, z).depth });
    }
    tiles.sort((a, b) => b.depth - a.depth);
    const put = (quad, fill, stroke) => {
      g.beginPath();
      quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.2; g.stroke(); }
    };
    for (const t of tiles) {
      const q = PROJ.tileQuad(cam, t.x, t.y, t.z, 0.02);
      let fill = "#3a4048";
      if (map.isWall(t.x, t.y)) fill = "#20242a";
      else if (t.z > 0) fill = "#8892a4";            // 高台
      else if (map.isPath(t.x, t.y)) fill = "#54606e"; // 通路
      if (t.x <= 7) fill = `color-mix(in srgb, ${fill} 82%, #2f6fb0)`;  // 己方部署区偏蓝
      put(q, fill, "rgba(255,255,255,.16)");
    }
    // 门
    for (const [team, gs] of Object.entries(map.gates || {})) {
      for (const gt of gs) {
        const p = cam.project(gt.x, gt.y + 0.5, zAt(gt.x, gt.y));
        g.strokeStyle = team === "blue" ? "#3fa9ff" : "#e8483c";
        g.lineWidth = 3;
        const w = 0.62 * p.s * 1.6, h = 1.75 * p.s;
        g.strokeRect(p.x - w / 2, p.y - h, w, h);
        g.fillStyle = g.strokeStyle;
        g.font = `bold ${Math.max(11, 0.22 * p.s)}px Microsoft YaHei`;
        g.textAlign = "center";
        g.fillText(team === "blue" ? "蓝门" : "红门", p.x, p.y - h - 6);
      }
    }
    g.textAlign = "left";
    PROJ.setViewport(960, 640);
  }
  $("mpClose").addEventListener("click", () => $("mapPreview").classList.add("hidden"));
  $("mpSelect").addEventListener("click", () => {
    const id = state.previewMapId || state.mapId || "cross";
    send({ type: "setMap", mapId: id });
    state.mapId = id;
    markMapSelection();
    $("mapPreview").classList.add("hidden");
  });
  renderMapGrid();
  markMapSelection();

  setInterval(() => {
    const d = new Date();
    $("homeClock").textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }, 1000);

  // ---------------- 演示模式（无服务器时本地预览，同一套 sim.js） ----------------
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo");
  if (demo === "draft" || demo === "battle") {
    const N = (DATA.balance && DATA.balance.draftPickEach) || 10;
    state.draft.picks.blue = OPS.slice(0, N).map((o) => o.id);
    state.draft.picks.red = OPS.slice(N, N * 2).map((o) => o.id);
  }
  if (demo === "battle") {
    const teamParam = params.get("team");
    if (teamParam === "red" || teamParam === "blue") state.team = teamParam;
    state.localSim = SIM.createSim(DATA);
    state.draft.picks.blue = ["cuora", "myrtle", "shining", "texas", "melantha",
      "kroos", "saria", "amiya", "silverash", "exusiai"];
    state.draft.picks.red = ["mudrock", "eyjafjalla", "thorns", "suzuran", "hoshiguma",
      "lappland", "ptilopsis", "ifrit", "siege", "ash"];
    state.localBattle = state.localSim.createBattle(state.draft.picks, params.get("map") || "cross");
    state.localBattle.cost.blue = 99;
    state.localBattle.cost.red = 99;
    const intent = (team, opId, route, skill) => {
      const r = state.localSim.applyIntent(state.localBattle, team, { kind: "deploy", opId, route, skillIndex: skill });
      if (!r.ok) log(`部署失败 ${opId}：${r.reason}`, "bad");
      return r;
    };
    // 贴身混战（特效展示/对战截图用）：站位按地图半场/通路自适应（跨图不落错半场）
    const M = state.localBattle.map;
    const half = M.half;
    const laneYs = [];
    for (let y = 0; y < M.height; y += 1) {
      if (M.routable(half - 1, y) && M.routable(half, y) && M.routable(half + 1, y)) laneYs.push(y);
    }
    const yA = laneYs[0] ?? 3;
    const yB = laneYs[1] ?? laneYs[0] ?? 8;
    // 站位按真实合法格自适应（初始部署区∧半场∧可部署∧未占位）：演示也走真规则
    const used = new Set();
    const pick = (team, ref, wantHigh) => {
      let best = null, bd = Infinity;
      for (let x = 0; x < M.width; x += 1) {
        for (let y = 0; y < M.height; y += 1) {
          const okTile = wantHigh ? M.highDeploy(x, y) : M.groundDeploy(x, y);
          if (!okTile || !M.inHalf(team, x) || !M.inInitialDeploy(team, x, y) || used.has(`${x},${y}`)) continue;
          const d = Math.hypot(x - ref.x, y - ref.y);
          if (d < bd) { bd = d; best = { x, y }; }
        }
      }
      if (best) used.add(`${best.x},${best.y}`);
      return best;
    };
    const refA = { x: half - 1, y: yA }, refA2 = { x: half - 1, y: yB };
    const refB = { x: half + 1, y: yA }, refB2 = { x: half + 1, y: yB };
    const t1 = pick("blue", refA, false); if (t1) intent("blue", "cuora", [t1]);
    const t2 = pick("blue", refA, false); if (t2) intent("blue", "myrtle", [t2]);
    const highTile = pick("blue", refA, true); if (highTile) intent("blue", "shining", [highTile]);
    const t3 = pick("blue", refA2, false); if (t3) intent("blue", "texas", [t3]);
    const t4 = pick("red", refB, false); if (t4) intent("red", "mudrock", [t4]);
    const t5 = pick("red", refB, false); if (t5) intent("red", "eyjafjalla", [t5]);
    const t6 = pick("red", refB2, false); if (t6) intent("red", "thorns", [t6]);
    const t7 = pick("red", refB2, false); if (t7) intent("red", "suzuran", [t7]);
    state.localBattle.elapsed = 95;
    applySnapshot(state.localSim.snapshot(state.localBattle));
    state.selectedUnitId = state.view.units.find((u) => u.opId === "cuora")?.id || state.view.units[0]?.id || null;
    switchScreen("battle");
    renderHand();
  } else if (demo === "draft") {
    switchScreen("draft");
    renderDraft();
  } else {
    runLoading();
  }

  connect();
  requestAnimationFrame(frame);

  // 测试/调试只读探针（不参与玩法）
  // —— 新手教程宿主：只读观察 + PC 侧合法意图通道（生产 sim；玩家侧真实键鼠；不改内部状态）——
  if ($("tutStartButton")) {
    $("tutStartButton").addEventListener("click", () => {
      if (window.AKF_TUTORIAL && window.AKF_TUTORIAL_HOST) window.AKF_TUTORIAL.start(window.AKF_TUTORIAL_HOST);
    });
  }
  window.AKF_TUTORIAL_HOST = {
    skillCasts: 0,
    retreats: 0,
    state: () => state,
    view: () => state.view,
    say: (t) => log(t, "good"),
    panel: (tut) => {
      const el = $("tutPanel");
      if (!el) return;
      el.classList.toggle("hidden", !tut);
      if (!tut) return;
      const step = tut.current();
      el.innerHTML = `<b>新手教程</b><span class="tutStep">${step ? `${tut.stepIndex + 1}/${tut.steps.length} ${step.title}` : "完成"}</span>
        <p>${step ? step.hint : "攻破红门，赢下演习！"}</p>`;
    },
    redIntent: (intent) => (state.localSim && state.localBattle
      ? state.localSim.applyIntent(state.localBattle, "red", intent)
      : { ok: false, reason: "未进入战斗" }),
    startLocalDraft: () => {
      state.localSim = null;
      state.localBattle = null;
      state.room = null;
      state.team = "blue";
      state.draft.picks.blue = [];
      state.draft.picks.red = ["kroos", "char_284_spot", "char_120_hibisc", "char_009_12fce", "char_212_ansel", "char_501_durin"];   // 教学 PC 实际六低星（与 WAVES 同源显示）
      state.draft.total = 8;
      state.preselect = null;
      switchScreen("draft");
      renderDraft();
    },
    startLocal: (cfg) => {
      state.localSim = SIM.createSim(DATA);
      state.draft.picks.blue = (cfg.bluePicks || []).map((p) => ({ opId: p.opId, skill: p.skill || 0 }));
      state.draft.picks.red = (cfg.red || ["mudrock"]).slice();
      state.localBattle = state.localSim.createBattle(state.draft.picks, cfg.mapId || "training");
      state.localBattle.cost.blue = 99;
      state.localBattle.cost.red = 99;              // 敌方（PC 导演）经济设定，不改玩家数值
      if (cfg.gateHp) {
        if (cfg.gateHp.red) state.localBattle.gateHp.red = cfg.gateHp.red;   // 教程关卡目标设定
        if (cfg.gateHp.blue) state.localBattle.gateHp.blue = cfg.gateHp.blue;
      }
      applySnapshot(state.localSim.snapshot(state.localBattle));
      state.selectedUnitId = null;
      switchScreen("battle");
      renderHand();
    },
  };

  window.__ARK_DEBUG__ = {
    state: () => ({
      screen: state.screen,
      team: state.team,
      selectedUnitId: state.selectedUnitId,
      selectedOpId: state.selectedOpId,
      view: state.view,
      routeDraft: state.routeDraft,
      enterCount: state.enterCount || 0,
      moveCount: state.moveCount || 0,
      clickCount: state.clickCount || 0,
      lastClick: state.lastClick || "",
      screenLog: state.screenLog || [],
    }),
    // 地块中心 → 页面坐标（供自动化测试点击）
    routeAt: (clientX, clientY) => routeTileAt({ x: (clientX - canvas.getBoundingClientRect().left) * canvas.width / canvas.getBoundingClientRect().width, y: (clientY - canvas.getBoundingClientRect().top) * canvas.height / canvas.getBoundingClientRect().height }),
    raw: (x, y) => {
      const cam = battleCam();
      const p = cam.project(x, y, heightAt(x, y));
      const r = canvas.getBoundingClientRect();
      const cx = r.left + p.x * r.width / canvas.width;
      const cy = r.top + p.y * r.height / canvas.height;
      const back = { x: (cx - r.left) * canvas.width / r.width, y: (cy - r.top) * canvas.height / r.height };
      return { proj: p, client: [cx, cy], back, un: cam.unproject(back.x, back.y, heightAt(x, y)), camP: cam.p };
    },
    pickAt: (clientX, clientY) => tileAt({ x: (clientX - canvas.getBoundingClientRect().left) * canvas.width / canvas.getBoundingClientRect().width, y: (clientY - canvas.getBoundingClientRect().top) * canvas.height / canvas.getBoundingClientRect().height }),
    tileToClient: (x, y) => {
      const cam = battleCam();
      const p = cam.project(x, y, heightAt(x, y));
      const r = canvas.getBoundingClientRect();
      const base = {
        x: r.left + p.x * r.width / canvas.width,
        y: r.top + p.y * r.height / canvas.height,
      };
      // 自证落点：在该格实际可见像素内找到 pickAt 回指 (x,y) 的点（解决投影锚点与拾取不闭合的边缘格）
      const pick = (cx, cy) => tileAt({ x: (cx - r.left) * canvas.width / r.width, y: (cy - r.top) * canvas.height / r.height });
      if (pick(base.x, base.y) && pick(base.x, base.y).x === x && pick(base.x, base.y).y === y) return base;
      for (let rad = 3; rad <= 15; rad += 3) {
        for (const [dx, dy] of [[0, -rad], [0, rad], [-rad, 0], [rad, 0], [-rad, -rad], [rad, rad], [-rad, rad], [rad, -rad]]) {
          const t = pick(base.x + dx, base.y + dy);
          if (t && t.x === x && t.y === y) return { x: base.x + dx, y: base.y + dy };
        }
      }
      return base;
    },
    // —— 四向朝向 / 小地图 / 相机只读探针（自动化测试用，不参与玩法）——
    facing: () => FACING.debug(),
    arrowScreen: (unitId) => FACING.arrowInfo(unitId),
    projectAt: (x, y, z) => { const p = battleCam().project(x, y, z); return { x: p.x, y: p.y, s: p.s }; },
    heightZ: (x, y) => heightAt(Math.round(x), Math.round(y)),
    pan: () => ({ x: (state.pan && state.pan.x) || 0, y: (state.pan && state.pan.y) || 0 }),
    cameraPreset: () => state.cameraPreset || "default",
    viewRect: () => {
      const m = currentMap();
      return { ...visibleGroundRect(battleCam(), m), raw: rawViewRect(battleCam()), map: { width: m.width, height: m.height } };
    },
    panLimits: () => panLimits(currentMap()),
    zoneInfo: () => {
      const { ground, high } = deployZones();
      const deployOp = operator(state.cardDrag?.opId || state.selectedOpId);
      const selU = selectedUnit();
      return {
        ground: ground.size,
        high: high.size,
        highCtx: !!((deployOp && deployOp.high) || state.highTarget || HIGHDRAG.active
          || (selU && selU.team === state.team && selU.positionMode === "high" && selU.highMoveAllowed && !selU.highMoveCooldown)),
      };
    },
    // —— 线路/高级模式只读探针（自动化测试用）——
    route: () => ({
      advanced: ROUTE.advanced,
      lineId: ROUTE.lineId,
      lineName: ROUTE.lineName(),
      lines: ROUTE.lines().map((l) => ({ id: l.id, name: l.name })),
      userPinned: ROUTE.userPinned,
      draftUnitId: ROUTE.draftUnitId,
      draftStart: ROUTE.draftStart,
      customPath: ROUTE.customPath.map((t) => ({ x: t.x, y: t.y })),
      waypoints: ROUTE.waypoints.map((t) => ({ x: t.x, y: t.y })),
      atGate: ROUTE.customAtGate(),
      draft: state.routeDraft.map((t) => ({ x: t.x, y: t.y })),
      bar: ($("routeLines") || {}).textContent || "",
    }),
    highDrag: () => (HIGHDRAG.active
      ? { unitId: HIGHDRAG.active.unitId, moved: HIGHDRAG.active.moved, tile: HIGHDRAG.active.tile }
      : null),
    miniToClient: (wx, wy) => {
      const r = miniCanvas.getBoundingClientRect();
      return { x: r.left + (wx + 0.5) * r.width / currentMap().width, y: r.top + (wy + 0.5) * r.height / currentMap().height };
    },
    safeArea: () => {
      const hand = document.querySelector(".btHand");
      const top = document.querySelector(".btTop");
      return {
        handTop: hand ? hand.getBoundingClientRect().top : null,
        topBottom: top ? top.getBoundingClientRect().bottom : null,
        clip: getComputedStyle(canvas).clipPath || "",
      };
    },
  };
})();

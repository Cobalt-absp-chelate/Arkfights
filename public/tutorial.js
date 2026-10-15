// 离线新手教程：脚本 PC 对手 + 生产 sim + 真实键鼠。
// 流程=最新交互：职业筛选 → 选干员/携带技能（门禁：≥1 手动技 + ≥1 高台）→ 拖卡落格立即驻守（也支持点卡再点格）
// → 拖动选向（按住高台模型拖向目标方向松手=确认朝向；小点击只选中）→ 选线路 Enter 开始行军（march，一次锁线不扣费）
// → 遇敌停步交战 → R 高台搬运（仅原高台且在台上，12s 冷却）→ F 下地落地面驻守
// → 拖动地面单位跟随己方干员（>8px 判拖动；任意地面单位均可拖，不跳过）→ E/技能按钮发动【手动】技能（技力条）
// → X 主动撤退 → 破门获胜 → 结算 → 返回终端。
// 步骤判据全部为真实行为等价（观察快照/事件/真实界面状态；PC 侧走 applyIntent 合法通道）：
// 不点按钮即过、不改内部状态、不跳过胜负、不暂停世界。
// 出兵与阶段用生产 battle.elapsed（模拟时间）驱动：低帧率/慢机器下 SP/费用/再部署与出兵节奏同步（修复墙钟排兵超前）。
// 教学门禁（真实状态判定，非点击即过）：未完成职业筛选不进战斗；阵容须≥1 名手动技能干员 + ≥1 名高台干员
// （保证选向/R/F/跟随全部可亲手完成）。R/F/选向在编队确无高台时按真实观察跳过并明示原因（防御兜底）；
// 跟随步骤永不跳过（跟随源=任意地面单位）。
// —— 文字展示节奏（不改 13 步流程与判据）：步骤文字【常驻不自动消失】，只在步骤真实完成时才换下一条；
// 显示位=引导面板正文（面板只在教程结束时隐藏，战局中永不自动关闭）。
// 推进=显式操作：空格/「空格 · 继续」按钮；回看=←/PageUp（或「← 上一步」按钮）重显上一步文字。
// 回看时 T.stepIndex 不动（不打断推进链），只在面板上展示上一步文字，任意操作后可再前进。
// 关键提示（门禁/编队要求/朝向/破门规则）以要点列表渲染且不截断（CSS 不设 max-height/省略号）。
(function () {
  // —— 数据侧只读查询（data.js / skill-controls.js 先后加载，均在调用时读取）——
  const opsOf = () => (window.ARKFIGHTS_DATA && window.ARKFIGHTS_DATA.operators) || [];
  const opById = (id) => opsOf().find((o) => o.id === id) || null;
  const pickList = (s) => (((s && s.draft && s.draft.picks && s.draft.picks.blue) || [])
    .map((p) => (p && typeof p === "object" ? { opId: p.opId, skill: p.skill || 0 } : { opId: p, skill: 0 })));
  const skillOfPick = (p) => {
    const op = opById(p.opId);
    if (!op) return null;
    return (op.skills && op.skills[p.skill || 0]) || op.skill || null;
  };
  // 可手动施放判定（与 app.js manualSkill + 生产 sim 同口径）：
  // SKILL_CONTROLS trigger === "MANUAL"，且排除 skillType=AUTO（SP 满自动发动、服务器拒绝手动施放）与“自动开启”技
  const isManualSkill = (sk) => {
    if (!sk) return true;
    const controls = ((window.AKF_SKILL_CONTROLS || {})[sk.id || ""]) || {};
    if (sk.skillType === "AUTO") return false;
    if (/自动开启/.test(String(sk.desc || ""))) return false;
    return (controls.trigger || "MANUAL") === "MANUAL";
  };
  const isManualPick = (p) => isManualSkill(skillOfPick(p));
  const isManualUnit = (u) => {
    const op = opById(u.opId);
    const sk = (op && op.skills && op.skills[u.skillIndex || 0]) || (op && op.skill) || null;
    return isManualSkill(sk);
  };
  const squadHasHigh = (s) => pickList(s).some((p) => { const op = opById(p.opId); return !!(op && op.high); });

  const T = (window.AKF_TUTORIAL = {
    active: false,
    phase: "draft",          // draft -> battle
    stepIndex: 0,
    // 文字展示节奏：常驻不自动消失；回看=lookbackStep（null=正在看当前步），不改 stepIndex
    lookbackStep: null,
    stepShownAt: 0,          // 当前步文字首次展示的时间（诊断/用例用）
    stepSeen: new Set(),     // 已展示过的步骤 id（诊断/用例用）
    manualSkillCasts: 0,     // 仅【手动】技能真实发动计数（AUTO/On-Deploy 的 E 被忽略，自动技能自行开也不计）
    retreats: 0,
    seenSkillActive: new Map(),
    seenFacingState: new Map(), // unitId → {sawUnconfirmed, fx, fy}：台上选向过程观察
    seenEvents: new Set(),   // 已观察过的战斗日志条目（对象同一性去重，逐条只计一次）
    sawEngaged: false,       // 曾观察到地面干员遇敌停步/被阻挡交战
    sawMarched: false,       // 曾观察到蓝方地面干员锁定完整行军线路（march 真实生效）
    sawHighMove: false,      // 曾观察到蓝方干员处于高台搬运冷却（只有 R 搬运成功才会进入冷却）
    sawDescended: false,     // 曾观察到蓝方干员已下地（descended 真实生效）
    sawFollow: false,        // 曾观察到蓝方干员建立跟随（followOf 真实生效）
    sawFacing: false,        // 曾观察到高台干员真实完成选向（facing 意图回执/台上 facingConfirmed 转正）
    skippedSteps: [],        // 因真实前置条件不满足而跳过的教学点（id 列表，供验证）
    steps: [
      {
        id: "filter", title: "职业筛选",
        hint: "选人池顶部可按职业筛选（先锋/近卫/重装/狙击/术师/医疗/辅助/特种），也可以直接搜名字。【本步要求】先点一次职业页签再进入战斗（进入战斗后无法补做本步）。",
        keys: [
          "门禁：进入战斗前必须点过一次职业页签——进入战斗后无法补做本步。",
        ],
        done: (v, s) => !!s.poolFilter && s.poolFilter !== "all",
      },
      {
        id: "pick", title: "选择干员与携带技能",
        hint: "点干员卡预选 → 点技能图标切换携带技能 → 确认选择（选满 2 名进入战斗）。【本步要求】至少 1 名干员携带【手动】技能（预选/信息面板标“手动触发 · E”；AUTO 自动技 SP 满会自行发动、E 会被忽略，不能当教学技能）＋至少 1 名高台干员（卡面标“高台”）——选向/R 搬运/F 下地教学都要亲手完成。",
        keys: [
          "编队要求：至少 1 名【手动】技能干员（预选面板标“手动触发 · E”）。AUTO 自动技的 E 会被忽略。",
          "编队要求：至少 1 名高台干员（卡面标“高台”）——选向 / R 搬运 / F 下地都要亲手完成。",
          "确认满 2 名干员后自动进入战斗。",
        ],
        done: (v, s) => pickList(s).length >= 2 && pickList(s).some(isManualPick) && squadHasHigh(s),
      },
      {
        id: "deploy", title: "拖卡落格 · 立即驻守",
        hint: "拖动底部部署卡到己方半场合法地块松手=立即落地驻守（也可以先点卡选中、再点格）。落地即驻守：地面干员原地驻守不移动，原高台干员落高台格=驻防台上（随后拖动选向）。",
        keys: [
          "只能落在己方半场 ∧ 初始部署区高亮格（拖到非法格会拒绝并提示原因）。",
        ],
        done: (v) => (v.units || []).some((u) => u.team === "blue"),
      },
      {
        id: "facing", title: "拖动选向",
        hint: "高台干员落格后按住它的模型，朝目标方向拖动松手＝确认朝向（拖动中实时看到攻击范围预览与脚下方向指示）；小点击只选中、不确认。备用：选向面板方向键+Enter、或点 ✓ 按钮。未确认朝向前该干员输出为 0。",
        keys: [
          "朝向规则：未确认朝向前该高台干员输出为 0。",
          "主操作=按住模型拖向目标方向松手；拖动 <10px 的小点击只选中、不确认。",
          "备用：方向键+Enter，或点 ✓ 按钮。",
        ],
        done: () => T.sawFacing,
        skip: (v, s) => (squadHasHigh(s) ? null : "本局编队没有高台干员，拖动选向无对象"),
      },
      {
        id: "march", title: "选线路 · Enter 开始行军",
        hint: "点选驻守中的干员 → 底部进攻线路条选一条线路（或保持“自动 · 部署点所在线路”）→ 按 Enter（或「开始行军」按钮）一次锁定行军线路（march：不扣部署费、不重复部署、可反复改线后再锁）。先选好线路与朝向再接敌：地面单位朝向=行进方向自动管理；高台干员先拖动选向（见上一步）再输出。",
        keys: [
          "march 不扣部署费、不重复部署；可反复改线后再锁。",
          "顺序：先选好线路与朝向，再接敌。",
        ],
        done: () => T.sawMarched,
      },
      {
        id: "engage", title: "遇敌停步交战",
        hint: "敌人进入射程干员会停下输出/治疗交战，威胁解除继续沿线路推进（不会后撤风筝）。记住顺序：先选好线路与朝向再接敌，然后再看输出与治疗。",
        keys: [
          "规则：接敌后不后撤风筝，威胁解除即继续沿线路推进。",
        ],
        done: () => T.sawEngaged,
      },
      {
        id: "highmove", title: "R · 高台搬运",
        hint: "选中【仍在台上】的原高台干员 → 按 R（或「R · 高台搬运」按钮）→ 点目标高台锚点；搬运冷却 12 秒，冷却中不可再搬。已下地/地面部署的干员本场不可搬运（需 X 撤退后重新部署上台）。",
        keys: [
          "仅【仍在台上】的原高台干员可搬运；已下地/地面部署的需 X 撤退后重新部署。",
          "冷却 12 秒；搬运到新台会重新发放一次选向（需再确认朝向）。",
        ],
        done: () => T.sawHighMove,
        skip: (v, s) => (squadHasHigh(s) ? null : "本局编队没有高台干员，R 搬运无对象"),
      },
      {
        id: "descend", title: "F · 下地行动",
        hint: "选中台上干员 → 按 F（或「F · 下地行动」按钮）→ 点高亮的相邻地面落点：落地面驻守并失去台上加成；本次在场不能再上台/搬运。",
        keys: [
          "落点须与当前格相邻且为合法地面格；落地面驻守并失去台上加成。",
          "本次在场不能再上台 / 搬运。",
        ],
        done: () => T.sawDescended,
        skip: (v, s) => (squadHasHigh(s) ? null : "本局编队没有高台干员，F 下地无对象"),
      },
      {
        id: "follow", title: "拖动跟随",
        hint: "按住己方任意地面单位（裁度这类地面干员、或下地的干员都行）拖到另一名己方干员身上松手=建立跟随（移动超过 8px 判为拖动、小于 8px 判为点选；拖到空白处松手=取消）。跟随者贴领队尾随、不瞬移不提速，领队离场自动解绑。",
        keys: [
          "阈值：>8px 判拖动、<8px 判点选；拖到空白处松手=取消。",
        ],
        done: () => T.sawFollow,
      },
      {
        id: "skill", title: "E · 发动手动技能",
        hint: "选中携带【手动】技能的干员 → 看信息面板技力条（SP，例如 4/8）攒满 → 按 E 或点技能按钮/场上 READY 菱形发动。只有【手动】技能响应 E；AUTO 自动技 SP 满会自行发动（不需也不能手动开）。本步只认【手动发动】，自动技能自行开启不算。高台干员注意先确认朝向，否则技能零输出。",
        keys: [
          "只有【手动】技能响应 E；AUTO 自动技自行发动、不计入本步。",
          "高台干员注意先确认朝向，否则技能零输出。",
        ],
        done: () => T.manualSkillCasts > 0,
        skip: (v, s) => (pickList(s).some(isManualPick) ? null : "本局编队没有手动技能干员"),
      },
      {
        id: "retreat", title: "X · 主动撤退",
        hint: "选中单位按 X（或「X · 主动撤退」按钮）：按原作返还部署费并进入再部署冷却，冷却后可再拖卡部署（满血回归）。",
        keys: [
          "返还部署费并进入再部署冷却；冷却后可再拖卡部署（满血回归）。",
        ],
        done: () => T.retreats > 0,
      },
      {
        id: "breach", title: "破门与获胜",
        hint: "干员沿行军线路走到敌方红门即突破：每次突破扣对方目标生命（教学关红门 3 点），先破尽对方目标生命即胜。",
        keys: [
          "破门规则：走到红门即突破，每次扣对方目标生命（教学关红门 3 点）。",
          "胜负：先破尽对方目标生命者获胜。",
        ],
        done: (v) => v.winner === "blue",
      },
      {
        id: "finish", title: "结算 · 返回终端",
        hint: "获胜后查看结算面板，点【返回主页】回到终端——教程到此完成。",
        done: (v, s) => s.screen === "home",
      },
    ],
  });

  T.current = () => T.steps[T.stepIndex] || null;

  // 逐格路线（相邻格递进；deploy 意图会做逐段相邻/可通行校验）
  const lane = (x0, y0, x1, y1) => {
    const r = [{ x: x0, y: y0 }];
    let x = x0;
    while (x !== x1) { x += Math.sign(x1 - x0); r.push({ x, y: y0 }); }
    return r;
  };

  // —— 教程 PC 对手导演：全部走 applyIntent 合法通道（红方费用=敌方经济设定）——
  // 敌方技能口径：AUTO 技（skillType=AUTO，如克洛丝二连射）由生产 sim SP 满自动施放；
  // MANUAL 技（芙蓉/安赛尔/斑点）教学导演不发技能意图、不施放（逐击账本。
  // 出兵时间轴单位=生产 battle.elapsed（模拟秒）。设计规则（设计文档 有完整时间轴与逐击账本）：
  // ① 首波延后 12s：新手仍在选线/选朝向时不被集火（10~15s 选择窗口）；
  // ② 每波 1 名（减员）、波间隔 ≥20s：给前排恢复/撤退再部署窗口；
  // ③ 危险目标绕前排：物理/重装/法伤交替走上路(y=3)/下路(y=4)，不叠同一条前排；
  // ④ 双奶隔开：芙蓉/安赛尔相隔 44s 且分置两线（HPS 248.1 只在敌方掉血时生效，不允许双奶同波）；
  // ⑤ 法师错峰：12F/杜林相隔 44s（同场基础 DPS 上限 180.7 不叠加）。
  const WAVES = [
    { t: 12, op: "kroos", route: lane(10, 3, 1, 3) },              // 阶段1 克洛丝·上路：物理低威胁首波单个
    { t: 32, op: "char_284_spot", route: lane(10, 4, 1, 4) },      // 阶段2 斑点·下路：重装阻挡3、绕开上路前排
    { t: 54, op: "char_120_hibisc", route: lane(10, 4, 1, 4) },    // 阶段3 芙蓉·下路：医疗#1（对我方0伤害，奶敌方）
    { t: 76, op: "char_009_12fce", route: lane(10, 3, 1, 3) },     // 阶段4 12F·上路：法伤#1（逐 RES 计伤）
    { t: 98, op: "char_212_ansel", route: lane(10, 3, 1, 3) },     // 阶段5 安赛尔·上路：医疗#2（与#1隔44s且分线）
    { t: 120, op: "char_501_durin", route: lane(10, 4, 1, 4) },    // 阶段6 杜林·下路：法伤#2（与12F隔44s错峰）
  ];
  T.WAVES = WAVES;

  T.tick = (host) => {
    if (!T.active) return;
    // 文字常驻看护：切换 screen（选人→战斗）/面板被别处隐藏时，把面板搬回当前可见容器并保住正文。
    // 只在「应显示却不可见」时补渲染，不重写已有内容（避免每帧重建 DOM）。
    const pel = document.getElementById("tutPanel");
    if (pel && T.currentOrDoneVisible()) {
      const want = T.hostScreenFor();
      if (pel.parentElement !== want || pel.classList.contains("hidden") || !pel.textContent) T.renderPanel();
    }
    const s = host.state();
    if (T.phase === "draft") {
      T.advance(host);                 // 选人阶段：观察筛选/选人推进
      T.maybeStartBattle(host);        // 教学门禁满足才离 draft（真实状态判定；未满足不进战斗）
      return;
    }
    const v = host.view();
    if (!v) return;
    // 排兵/阶段一律用生产 battle.elapsed（模拟时间）：低帧率下与 SP/费用/再部署节奏一致
    const elapsed = Number.isFinite(v.elapsed) ? v.elapsed : 0;
    if (!v.winner) {
      for (let i = 0; i < WAVES.length; i += 1) {
        const w = WAVES[i];
        if (!T["_w" + i] && elapsed >= w.t) {
          // 出兵点被占/费用不足等被拒时下个 tick 重试（波次不丢）；对局结束不再尝试
          const r = host.redIntent({ kind: "deploy", opId: w.op, route: w.route.slice() });
          if (!r || r.ok) T["_w" + i] = true;
        }
      }
    }
    for (const u of v.units) {
      // 技能发动计数：仅【手动】技能真实进入发动状态（逐单位 false→true 观察一次）；
      // AUTO/On-Deploy 技能的 E 被 skill-controls 忽略，其自动开启也不计（判据=真实手动发动）。
      const prev = T.seenSkillActive.get(u.id);
      if (u.team === "blue" && prev === false && u.skillActive && isManualUnit(u)) T.manualSkillCasts += 1;
      T.seenSkillActive.set(u.id, !!u.skillActive);
      if (u.team !== "blue") continue;
      // 选向真实完成（拖动/按钮/键盘都算真实操作，点击不算）：
      // ① 台上观察到 facingConfirmed 由待确认转正（只有 facing 意图会转）；
      // ② 台上朝向向量发生变化（拖动改向重确认）。
      const fs = T.seenFacingState.get(u.id) || {};
      if (u.positionMode === "high") {
        if (u.facingConfirmed === false) fs.sawUnconfirmed = true;
        else if (fs.sawUnconfirmed) T.sawFacing = true;
        const fx = u.facing ? u.facing.x : null, fy = u.facing ? u.facing.y : null;
        if (fs.fx != null && (fs.fx !== fx || fs.fy !== fy)) T.sawFacing = true;
        fs.fx = fx; fs.fy = fy;
      }
      T.seenFacingState.set(u.id, fs);
      // 遇敌判据只看地面行动干员：台上干员静止驻防，其 stopReason 不代表行进/交战
      if (u.positionMode === "ground" && (u.stopReason === "engaged" || u.stopReason === "blocked")) T.sawEngaged = true;
      // march 真实生效=锁定完整行军线路（单格部署驻守 routeLen=1 不锁线；只有 march/带线路下地才满足）
      if (u.routeLocked && u.routeLen > 1) T.sawMarched = true;
      // R 搬运真实生效=进入 12s 搬运冷却（只有 highMove 成功才置冷却）
      if (u.highMoveCooldown > 0) T.sawHighMove = true;
      // F 下地真实生效=descended 置位（地面部署不置位）
      if (u.descended) T.sawDescended = true;
      // 跟随真实生效=快照 followOf 指向己方领队
      if (u.followOf) T.sawFollow = true;
    }
    // 主动撤退计数：只认真实“主动撤退”（玩家 X / 撤退按钮）离场，一次动作只计一次：
    // 首选快照战斗日志新增“XX 主动撤退”条目（蓝方视角 tone=bad；阵亡“已阵亡撤退”、技能退场“技能结束并撤退”不计）；
    // 快照无事件流时退回 exits 中 reason==='retreat'（意图离场在两次 tick 之间发生时可能被 tick 重置，故不与事件流并计）。
    if (Array.isArray(v.events)) {
      for (const e of v.events) {
        if (T.seenEvents.has(e)) continue;
        T.seenEvents.add(e);
        const text = String(e.text || "");
        if (e.tone === "bad" && /主动撤退/.test(text)) T.retreats += 1;
        if (e.tone === "good" && /确认朝向/.test(text)) T.sawFacing = true;   // 服务器 facing 回执
      }
    } else {
      for (const e of (v.exits || [])) {
        if (e.team === "blue" && e.reason === "retreat") T.retreats += 1;
      }
    }
    T.advance(host);
  };

  T.advance = (host) => {
    const step = T.current();
    if (!step) return;
    const v = host.view() || {};
    const s = host.state();
    const skipReason = step.skip ? step.skip(v, s) : null;
    if (skipReason && !(step.done && step.done(v, s, host))) {
      // 真实前置条件不满足（编队构成等，非点击即过）→ 明示原因后跳过该教学点
      T.skippedSteps.push(step.id);
      host.say(`【教程】${step.title}：${skipReason}——本局自动跳过该教学点。`);
      T.stepIndex += 1;
      T.announce(host);
      return;
    }
    if (step.done(v, s, host)) {
      T.stepIndex += 1;
      T.announce(host);
    }
  };

  // 面板宿主：index.html 里 #tutPanel 位于 #battleScreen 内，选人（draft）阶段该 section 是 hidden
  // → 原实现下第 1~2 步的文字在选人页【根本看不见】。本代理无 index.html 权限，
  // 故在渲染时把面板节点按需搬进当前可见的 screen，保证文字在全程可见且常驻。
  // 判定用 DOM 真实可见性（而不是 state.screen 字符串）：切屏动画/演示直达战斗等中间态下更可靠。
  const screenVisible = (id) => {
    const el = document.getElementById(id);
    if (!el) return false;
    if (el.classList.contains("hidden")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  T.hostScreenFor = () => {
    if (screenVisible("battleScreen")) return document.getElementById("battleScreen");
    if (screenVisible("draftScreen")) return document.getElementById("draftScreen");
    // 两者都不可见（加载/结算过渡）：沿用 state 提示，回退战斗页（原宿主）
    const screen = (window.AKF_TUTORIAL_HOST && window.AKF_TUTORIAL_HOST.state().screen) || "battle";
    return document.getElementById(screen === "draft" ? "draftScreen" : "battleScreen")
      || document.getElementById("battleScreen");
  };
  T.placePanel = () => {
    const el = document.getElementById("tutPanel");
    const host = T.hostScreenFor();
    if (!el || !host) return el;
    if (el.parentElement !== host) host.appendChild(el);   // 同屏=不移动（避免无谓重排）
    return el;
  };

  // —— 面板样式（从本文件注入：本代理只有 tutorial.js 权限，不改 styles.css）——
  // 关键点：正文【不设 max-height / overflow:hidden / 省略号】，要点列表可见且完整换行——文字永不被截断。
  T.injectStyles = () => {
    if (document.getElementById("tutPanelStyles")) return;
    const st = document.createElement("style");
    st.id = "tutPanelStyles";
    st.textContent = `
      #tutPanel.tutPanel { max-width: 340px; max-height: calc(100vh - 120px); overflow-y: auto; }
      #tutPanel .tutHint { white-space: normal; word-break: break-word; }
      #tutPanel .tutBackBadge {
        float: right; margin-left: 8px; padding: 1px 7px; font-size: 11px;
        color: #111; background: var(--ak-accent, #ffd75e); font-weight: 700;
      }
      #tutPanel .tutKeys {
        margin: 9px 0 0; padding: 8px 10px 8px 26px; list-style: disc;
        background: rgba(255, 215, 94, .08); border-left: 3px solid var(--ak-accent, #ffd75e);
      }
      #tutPanel .tutKeys li {
        color: rgba(255, 255, 255, .92); font-size: 12px; line-height: 1.7;
        white-space: normal; word-break: break-word; margin: 3px 0;
      }
      #tutPanel .tutActions { display: flex; gap: 8px; margin-top: 10px; }
      #tutPanel .tutBtn {
        flex: 1; padding: 6px 8px; font-size: 12px; letter-spacing: 1px; cursor: pointer;
        color: #111; background: var(--ak-accent, #ffd75e); border: 0; font-weight: 700;
      }
      #tutPanel .tutBtnGhost { color: rgba(255,255,255,.9); background: rgba(255,255,255,.12); font-weight: 400; }
      #tutPanel .tutBtn:disabled { opacity: .38; cursor: default; }
      #tutPanel .tutFoot { margin-top: 7px; color: rgba(255,255,255,.5); font-size: 11px; line-height: 1.5; }
    `;
    document.head.appendChild(st);
  };
  T.injectStyles();

  // —— 文字展示节奏：常驻不自动消失 ——
  // 唯一会换掉面板正文的时机=教学步骤【真实推进】(/跳过)。面板本身在战局中永不自动隐藏、正文不被定时器清空。
  // 推进=显式操作（空格 / 「空格 · 继续」按钮）；回看=← / PageUp（或「← 上一步」按钮）。
  //
  // 渲染分工：app.js 的 host.panel(tut) 负责面板骨架（它读 tut.current/tut.stepIndex，语义=当前步，保持不变）；
  // 本文件在 app.js 渲染之后做一次「正文补全」——补上回看态/要点列表/按钮，且【不自动消失】。
  // 这样 app.js 无需改动（本代理无 app.js 权限），而面板正文完全由这里掌控。
  T.renderPanel = () => {
    const el = document.getElementById("tutPanel");
    if (!el) return;
    if (!T.active) return;                       // 未激活=不接管（app.js 已隐藏）
    const shown = T.displayStep();
    const lookback = T.isLookback();
    const total = T.steps.length;
    const shownIdx = lookback ? T.lookbackStep : T.stepIndex;
    // 结算/终端页不再悬浮教程面板（教程完成时 T.active 仍为真，直到 stop）；
    // 战局与选人页=常驻显示，加载页=暂不显示（避免盖在载入层上）。
    const scr = (window.AKF_TUTORIAL_HOST && window.AKF_TUTORIAL_HOST.state().screen) || "battle";
    if (scr !== "battle" && scr !== "draft") { el.classList.add("hidden"); return; }
    T.placePanel();                              // 按当前 screen 搬到可见容器（draft/battle 全程可见）
    el.classList.remove("hidden");               // 常驻：只要教程在跑就不隐藏
    // app.js 已写入标题/序号，这里整体重写为「正文补全」版：序号与标题同源，正文=完整不截断 + 要点 + 按钮
    el.innerHTML = [
      `<b>新手教程</b>`,
      `<span class="tutStep">${shown ? `${shownIdx + 1}/${total} ${shown.title}` : "完成"}</span>`,
      lookback ? `<span class="tutBackBadge">回看中</span>` : ``,
      `<p class="tutHint">${shown ? shown.hint : "攻破红门，赢下演习！"}</p>`,
      shown && shown.keys && shown.keys.length
        ? `<ul class="tutKeys">${shown.keys.map((k) => `<li>${k}</li>`).join("")}</ul>`
        : ``,
      `<div class="tutActions">`,
      `<button type="button" class="tutBtn" data-tut-action="continue">空格 · 继续</button>`,
      `<button type="button" class="tutBtn tutBtnGhost" data-tut-action="back"${shownIdx <= 0 ? " disabled" : ""}>← 上一步</button>`,
      `</div>`,
      `<div class="tutFoot">文字常驻不自动消失 · 空格/「继续」推进 · ←/PageUp 回看</div>`,
    ].join("");
  };
  // 包装 host.panel：先让 app.js 出骨架（保留其隐藏/显示语义），再补全正文
  T.wrapHost = (host) => {
    if (!host || host.__tutWrapped) return host;
    const orig = host.panel;
    host.panel = (tut) => {
      if (typeof orig === "function") orig(tut);
      if (tut) T.renderPanel();
    };
    host.__tutWrapped = true;
    return host;
  };

  T.announce = (host) => {
    if (host) T.wrapHost(host);
    const next = T.current();
    T.lookbackStep = null;                       // 换步=退出回看态，正文回到当前步
    T.stepShownAt = Date.now();
    if (next) T.stepSeen.add(next.id);
    host.say(next ? `【教程】${next.title}：${next.hint}` : "【教程】要领已掌握——攻破红门，赢下这场演习！");
    host.panel(T);
  };

  // 当前面板应展示的步骤（回看态=上一步；否则=当前步）
  T.displayStep = () => {
    const i = T.lookbackStep == null ? T.stepIndex : T.lookbackStep;
    return T.steps[i] || null;
  };
  T.isLookback = () => T.lookbackStep != null;
  // 面板是否应当可见：教程进行中恒为真（文字常驻）；仅 T.stop 后为假
  T.currentOrDoneVisible = () => T.active === true;

  // 回看上一步：只切换面板展示，【不动 stepIndex】（不打断真实推进链/判据）
  T.backStep = (host) => {
    const target = Math.min(T.stepIndex, T.steps.length - 1);
    if (target <= 0) {
      // 已是第一步：明确告知无可回看（非静默、不影响判据）
      T.lookbackStep = null;
      host.say("【教程】这已经是第一步了，没有更早的步骤可回看。");
      host.panel(T);
      return false;
    }
    const prev = target - 1;
    if (T.lookbackStep != null && T.lookbackStep <= prev - 1) {
      // 连续回看：继续往前翻（最多到第 1 步）
      T.lookbackStep = Math.max(0, T.lookbackStep - 1);
    } else {
      T.lookbackStep = prev;
    }
    const st = T.steps[T.lookbackStep];
    host.say(`【教程 · 回看】${st.title}：${st.hint}`);
    host.panel(T);
    return true;
  };

  // 显式推进（空格/「继续」按钮）：作用=结束回看态并回到当前步正文。
  // 教学步骤的推进本身始终由【真实行为】驱动（T.advance），按键不替代行为、不跳过判据。
  T.continueStep = (host) => {
    const wasLookback = T.lookbackStep != null;
    T.lookbackStep = null;
    const cur = T.current();
    if (wasLookback) host.say(`【教程】回到当前步骤：${cur ? cur.title : "完成"}`);
    host.panel(T);
    return wasLookback;
  };

  // —— 教学门禁（真实状态判定；由 app.js 的确认按钮直接调用，也由 tick 在条件补齐后自动收口）——
  // 入门编队约束：≥2 名（含 ≥1 手动技 + ≥1 高台）——保证选向/R/F/跟随全部可亲手完成
  T.filterDone = (s) => T.stepIndex >= 1 || (!!s.poolFilter && s.poolFilter !== "all");
  T.pickDone = (s) => pickList(s).length >= 2 && pickList(s).some(isManualPick) && squadHasHigh(s);

  T.maybeStartBattle = (host) => {
    if (T.phase !== "draft") return;
    const s = host.state();
    if (!T.filterDone(s) || !T.pickDone(s)) return;
    T.onPicked(host);
  };

  // 选人阶段结束（门禁满足）→ 进入战斗
  T.onPicked = (host) => {
    if (T.phase !== "draft") return;
    const s = host.state();
    if (!T.filterDone(s)) {
      host.say("【教程】还差一步：请先在选人池顶部点击一次职业筛选页签（如“狙击”/“近卫”），完成职业筛选后自动进入战斗。");
      host.panel(T);
      return;
    }
    const picks = pickList(s);
    if (picks.length < 2 || !picks.some(isManualPick)) {
      host.say("【教程】教学阵容要求：至少 1 名干员携带【手动】技能（AUTO/自动触发技的 E 会被忽略，技能步骤会卡住）——再确认 1 名干员，或在卡面上点技能图标切换为手动技能后再确认。");
      host.panel(T);
      return;
    }
    if (!squadHasHigh(s)) {
      host.say("【教程】教学阵容要求：至少 1 名高台干员（卡面标“高台”）——拖动选向/R 高台搬运/F 下地教学都要亲手完成；再确认 1 名高台干员后自动进入战斗。");
      host.panel(T);
      return;
    }
    T.phase = "battle";
    T.seenSkillActive = new Map();
    T.seenFacingState = new Map();
    T.seenEvents = new Set();
    T.manualSkillCasts = 0;
    T.retreats = 0;
    T.sawEngaged = false;
    T.sawMarched = false;
    T.sawHighMove = false;
    T.sawDescended = false;
    T.sawFollow = false;
    T.sawFacing = false;
    T.lookbackStep = null;               // 进战斗=退出回看态（正文回到当前步）
    for (let i = 0; i < WAVES.length; i += 1) T["_w" + i] = false;
    host.startLocal({
      mapId: "training",
      bluePicks: picks,
      red: WAVES.map((w) => w.op),
      gateHp: { red: 3, blue: 20 },   // 教程关卡目标：快速攻破、防守容错（不改伤害/费用/再部署/治疗）
    });
    const step = T.current();
    if (step) T.stepSeen.add(step.id);
    T.stepShownAt = Date.now();
    if (step) host.say(`【教程】${step.title}：${step.hint}`);
    host.panel(T);
  };

  T.start = (host) => {
    T.wrapHost(host);                    // 一开始就接管面板正文补全（常驻/要点/按钮）
    T.active = true;
    T.phase = "draft";
    T.stepIndex = 0;
    T.manualSkillCasts = 0;
    T.retreats = 0;
    T.seenSkillActive = new Map();
    T.seenFacingState = new Map();
    T.seenEvents = new Set();
    T.sawEngaged = false;
    T.sawMarched = false;
    T.sawHighMove = false;
    T.sawDescended = false;
    T.sawFollow = false;
    T.sawFacing = false;
    T.skippedSteps = [];
    T.lookbackStep = null;               // 每次开教程=退出回看态
    T.stepSeen = new Set();
    host.skillCasts = 0;
    host.retreats = 0;
    host.startLocalDraft();
    const step = T.current();
    host.say(`【教程】${step.title}：${step.hint}`);
    host.panel(T);
  };

  T.stop = (host) => {
    T.active = false;
    T.phase = "draft";
    T.lookbackStep = null;
    host.panel(null);
  };

  // —— 显式推进 / 回看的真实键盘绑定 ——
  // 只在教程进行中拦截：(1) 空格=继续（结束回看态/保持当前步正文常驻）；
  // (2) ←、PageUp=回看上一步文字。全程【不暂停世界、不改判据、不动 stepIndex】。
  // 用 capture 阶段是为了在 app.js 的 window 级 keydown 之前拿到空格——app.js 把空格绑给了
  // ROUTE.autoRoute，教程中空格必须归教程（非教程/非激活时一律不拦，原行为不变）。
  // 不在输入框内拦截（选人搜索框要能打空格），否则纯打字被吞。
  const inEditable = (el) => !!el && (el.matches?.("input,textarea,select") || el.isContentEditable);
  T.handleKey = (e) => {
    if (!T.active) return false;
    if (e.repeat) return false;
    if (inEditable(e.target)) return false;
    const host = window.AKF_TUTORIAL_HOST;
    if (!host) return false;
    const k = e.key;
    if (k === " " || e.code === "Space") { T.continueStep(host); return true; }
    if (k === "PageUp" || k === "ArrowLeft") { T.backStep(host); return true; }
    return false;
  };
  window.addEventListener("keydown", (e) => {
    if (!T.handleKey(e)) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();          // 教程中空格/← 不再触发 app.js 的自动寻路/线路循环
  }, true);

  // —— 面板内按钮（「空格 · 继续」/「← 上一步」）——与键盘同一入口，事件委托到 #tutPanel ——
  // 面板每次 render 重写 innerHTML，故用 document 级委托（不在 render 里重复绑定）。
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest && e.target.closest("#tutPanel [data-tut-action]");
    if (!btn) return;
    const host = window.AKF_TUTORIAL_HOST;
    if (!host || !T.active) return;
    const act = btn.dataset.tutAction;
    if (act === "continue") T.continueStep(host);
    else if (act === "back") T.backStep(host);
    e.preventDefault();
    e.stopPropagation();
  }, true);
})();

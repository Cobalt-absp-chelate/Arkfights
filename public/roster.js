/* 干员图鉴视图（AKF_ROSTER）
   数据：public/roster-data.json（全量干员 + 技能 + 缺项清单）
   对外接口：
     window.AKF_ROSTER.render(container, options) -> Promise  （在 container 内自渲染全部 UI）
     window.AKF_ROSTER.counts() -> { total, playable, missingArt, missingIcon }
   options:
     dataUrl  数据地址（默认 "roster-data.json"）
     data     预加载的数据对象（提供则不 fetch）
     select   预选干员（charId 或对战池 id）
     playable 对战池集合（提供则以它判定「可出战」，覆盖数据内的 playable 标记）
*/
(function () {
  "use strict";

  var DATA = null;
  var POOL = null;
  var STATE = { scope: "all", profession: "all", query: "", selected: null };
  var ELS = {};

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function counts() {
    if (!DATA) return { total: 0, playable: 0, missingArt: 0, missingIcon: 0 };
    var c = DATA.counts || {};
    return {
      total: c.total || 0,
      playable: c.playable || 0,
      missingArt: c.missingArt || 0,
      missingIcon: c.missingIcon || 0
    };
  }

  /* ---------- 范围格绘制（range_table grids） ---------- */
  function drawRange(canvas, grids) {
    if (!canvas) return;
    if (!grids || !grids.length) {
      canvas.style.display = "none";
      return;
    }
    canvas.style.display = "block";
    var cell = 26, pad = 9;
    var minR = 0, maxR = 0, minC = 0, maxC = 0;
    grids.forEach(function (g) {
      minR = Math.min(minR, g.row); maxR = Math.max(maxR, g.row);
      minC = Math.min(minC, g.col); maxC = Math.max(maxC, g.col);
    });
    var cols = maxC - minC + 1, rows = maxR - minR + 1;
    var w = cols * cell + pad * 2, h = rows * cell + pad * 2;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    function xOf(col) { return pad + (col - minC) * cell; }
    function yOf(row) { return pad + (maxR - row) * cell; } // row 向上为正

    // 底格
    for (var r = minR; r <= maxR; r++) {
      for (var c = minC; c <= maxC; c++) {
        ctx.strokeStyle = "rgba(79,195,247,0.12)";
        ctx.strokeRect(xOf(c) + 0.5, yOf(r) + 0.5, cell - 1, cell - 1);
      }
    }
    // 范围格
    grids.forEach(function (g) {
      var x = xOf(g.col), y = yOf(g.row);
      var origin = g.row === 0 && g.col === 0;
      ctx.fillStyle = origin ? "rgba(255,200,87,0.85)" : "rgba(79,195,247,0.55)";
      ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      ctx.strokeStyle = origin ? "#ffc857" : "#4fc3f7";
      ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      if (origin) {
        ctx.fillStyle = "#10202f";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("自", x + cell / 2, y + cell / 2 + 1);
      }
    });
  }

  /* ---------- 过滤与列表 ---------- */
  // 对战池判定：优先用调用方传入的 playable 集合（与当前对战池数据严格一致），
  // 未传入时回落到数据内记录的 playable 标记。
  function isPlayable(op) {
    if (!op) return false;
    if (POOL) {
      return !!((op.battleId && POOL.has(op.battleId)) || (op.charId && POOL.has(op.charId)));
    }
    return !!op.playable;
  }

  function poolSize() {
    if (POOL && DATA) {
      var n = 0;
      for (var i = 0; i < DATA.operators.length; i += 1) if (isPlayable(DATA.operators[i])) n += 1;
      return n;
    }
    return (DATA && DATA.counts && DATA.counts.playable) || 0;
  }

  function visibleOperators() {
    var q = STATE.query.trim().toLowerCase();
    return DATA.operators.filter(function (op) {
      var play = isPlayable(op);
      if (STATE.scope === "playable" && !play) return false;
      if (STATE.scope === "gallery" && play) return false;
      if (STATE.profession !== "all" && op.profession !== STATE.profession) return false;
      if (!q) return true;
      var hay = [op.name, op.charId, op.appellation, op.subProfessionCn || op.subProfessionId,
                 op.professionCn, op.battleId || ""].join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function renderList() {
    var ops = visibleOperators();
    var html = ['<div class="akx-list__hint">共 ' + ops.length + " 名 · 点击查看详情（" +
      '<span class="akx-badge akx-badge--play">对战池</span> = 已接入对战，' +
      '<span class="akx-badge akx-badge--gallery">图鉴</span> = 图鉴收录）</div>'];
    if (!ops.length) {
      html.push('<div class="akx-empty">没有符合条件的干员</div>');
    }
    ops.forEach(function (op) {
      var ava = op.avatar
        ? '<img src="' + esc(op.avatar) + '" alt="">'
        : esc(op.name.slice(0, 2));
      html.push(
        '<button type="button" class="akx-row' + (op.charId === STATE.selected ? " on" : "") +
        '" data-char="' + esc(op.charId) + '">',
          '<span class="akx-row__ava">' + ava + "</span>",
          "<span>",
            '<span class="akx-row__name">' + esc(op.name) +
              '<span class="stars">' + esc(op.rarityLabel) + "</span></span>",
            '<span class="akx-row__meta">' + esc(op.professionCn) + " · " +
              esc(op.subProfessionCn || "") + "</span>",
          "</span>",
          '<span class="akx-badge ' + (isPlayable(op) ? "akx-badge--play" : "akx-badge--gallery") + '">' +
            (isPlayable(op) ? "可出战" : "仅图鉴") + "</span>",
        "</button>"
      );
    });
    ELS.list.innerHTML = html.join("");
  }

  /* ---------- 详情 ---------- */
  function statCard(k, v, unit) {
    return '<div class="akx-stat"><span class="k">' + esc(k) + '</span><span class="v">' +
      esc(v == null ? "—" : v) + (unit ? "<small>" + esc(unit) + "</small>" : "") + "</span></div>";
  }

  function renderDetail(op) {
    if (!op) {
      ELS.detail.innerHTML = '<div class="akx-empty">请选择左侧干员</div>';
      return;
    }
    var s = op.stats || {};
    var html = [];

    html.push('<div class="akx-hero">');
    // 立绘
    html.push('<div class="akx-art">');
    if (op.art) {
      html.push('<img src="' + esc(op.art) + '" alt="' + esc(op.name) + ' 立绘">');
    } else {
      html.push('<div class="akx-art__none">该干员暂无立绘' +
        "<small>" + esc(op.charId) + "</small></div>");
    }
    html.push("</div>");

    // 身份信息
    html.push('<div class="akx-id">');
    html.push("<h2>" + esc(op.name) + "</h2>");
    if (op.appellation) html.push('<div class="appellation">' + esc(op.appellation) + "</div>");
    html.push('<div class="akx-tags">');
    html.push('<span class="akx-tag akx-tag--star">' + esc(op.rarityLabel) + "</span>");
    html.push('<span class="akx-tag ' + (isPlayable(op) ? "akx-tag--play" : "akx-tag--gallery") + '">' +
      esc(op.availabilityLabel) + "</span>");
    html.push('<span class="akx-tag">' + esc(op.professionCn) + "</span>");
    html.push('<span class="akx-tag">' +
      esc(op.subProfessionCn || "") + "</span>");
    html.push("</div>");

    html.push('<div class="akx-note">属性按精英化满级计算（不含潜能 / 信赖加成） · 精英阶段数 ' +
      esc(s.phaseCount) + " · 满级 Lv" + esc(s.phaseMaxLevel) + "</div>");

    // 属性
    html.push('<div class="akx-stats-grid">');
    html.push(statCard("生命", s.maxHp));
    html.push(statCard("攻击", s.atk));
    html.push(statCard("防御", s.def));
    html.push(statCard("法抗", s.magicResistance, "%"));
    html.push(statCard("攻击间隔", s.baseAttackTime, "秒（攻速" + (s.attackSpeed == null ? "—" : s.attackSpeed) + "）"));
    html.push(statCard("阻挡", s.blockCnt));
    html.push(statCard("原作部署费用", s.cost));
    html.push(statCard("再部署时间", s.respawnTime, "秒"));
    html.push(statCard("移动速度", s.moveSpeed));
    html.push(statCard("攻击范围 ID", s.rangeId == null ? "—" : String(s.rangeId)));
    html.push("</div>");

    // 范围格
    html.push('<div class="akx-range" data-sec="range">');
    html.push('<canvas class="akx-range__canvas" width="10" height="10"></canvas>');
    html.push('<div><div class="k">攻击范围 rangeId = <b>' + esc(op.range.rangeId == null ? "—" : op.range.rangeId) +
      "</b>（源自 range_table.json 的 grids）</div>");
    html.push('<div class="legend">' +
      '<span class="akx-swatch" style="background:rgba(255,200,87,0.85)"></span>自身所在格（row 0 / col 0）<br>' +
      '<span class="akx-swatch" style="background:rgba(79,195,247,0.55)"></span>攻击范围格（col 向前，row 向上）</div></div>');
    html.push("</div>"); // /akx-range
    html.push("</div>"); // /akx-id
    html.push("</div>"); // /akx-hero

    // 特性
    html.push('<div class="akx-sec" data-sec="trait"><h3>特性（Trait）</h3>');
    if (op.trait && op.trait.text) {
      html.push('<div class="akx-text-block">' + esc(op.trait.text) +
        '<span class="src">来源：' + esc(op.trait.source || "官方表") + "</span></div>");
    } else {
      html.push('<div class="akx-text-block"><span class="akx-missing-label">该干员特性文案暂缺</span></div>');
    }
    html.push("</div>");

    // 天赋
    html.push('<div class="akx-sec" data-sec="talents"><h3>天赋（Talents）</h3>');
    if (op.talents && op.talents.length) {
      op.talents.forEach(function (t) {
        html.push('<div class="akx-talent"><b>' + esc(t.name || "（无名天赋）") + "</b>" +
          '<span class="unlock">解锁：' + esc(t.unlockText) + "（无潜能形态）</span>" +
          "<div>" + esc(t.description || "（官方表无描述）") + "</div></div>");
      });
    } else {
      html.push('<div class="akx-text-block"><span class="akx-missing-label">官方表无天赋条目</span></div>');
    }
    html.push("</div>");

    // 技能
    html.push('<div class="akx-sec" data-sec="skills"><h3>技能（Skills，共 ' + (op.skills ? op.skills.length : 0) + " 个）</h3>");
    if (op.skills && op.skills.length) {
      op.skills.forEach(function (sk) {
        html.push('<div class="akx-skill">');
        html.push('<div class="akx-skill__icon">');
        if (sk.icon) {
          html.push('<img src="' + esc(sk.icon) + '" alt="' + esc(sk.name) + ' 图标">');
        } else {
          html.push('<div class="akx-skill__noicon">图标缺失<br>·待提取·</div>');
        }
        html.push("</div>");
        html.push('<div class="akx-skill__body">');
        html.push('<div class="akx-skill__name">' + esc(sk.name) +
          (sk.icon ? "" : ' <span class="akx-tag akx-tag--warn">【图标缺失·待提取】</span>') +
          ' <span class="akx-tag akx-tag--id">' + esc(sk.skillId) + "</span></div>");
        html.push('<div class="akx-skill__meta">');
        html.push('<span class="akx-tag">SP类型：' + esc(sk.spTypeCn) + "</span>");
        html.push('<span class="akx-tag">初始 SP：' + esc(sk.initSp == null ? "—" : sk.initSp) + "</span>");
        html.push('<span class="akx-tag">消耗 SP：' + esc(sk.spCost == null ? "—" : sk.spCost) + "</span>");
        html.push('<span class="akx-tag">持续：' +
          esc(sk.duration == null ? "—" : (sk.duration === 0 ? "0 秒（瞬发）" : sk.duration + " 秒")) + "</span>");
        html.push('<span class="akx-tag">触发：' + esc(sk.skillTypeCn) + "</span>");
        html.push("</div>");
        html.push('<p class="akx-skill__desc">' + esc(sk.description || "（官方表无说明）") +
          '<span class="tier">说明：官方 skill_table description（' + esc(sk.descTier) +
          "）；SP 类型/初始/消耗取该档 spData，持续取该档 levels[].duration（官方字段）</span></p>");
        html.push("</div></div>");
      });
    } else {
      html.push('<div class="akx-text-block"><span class="akx-missing-label">官方表无技能条目</span></div>');
    }
    html.push("</div>");

    ELS.detail.innerHTML = html.join("");
    drawRange(ELS.detail.querySelector(".akx-range__canvas"), op.range && op.range.grids);
    ELS.detail.scrollTop = 0;
  }

  /* ---------- 顶栏 ---------- */
  function renderBar() {
    var c = DATA.counts || {};
    ELS.stats.innerHTML = [
      '<span class="akx-chip">全量干员 <b>' + (c.total || 0) + "</b></span>",
      '<span class="akx-chip akx-chip--play">可出战 <b>' + poolSize() + "</b></span>",
      '<span class="akx-chip">仅图鉴 <b>' + Math.max(0, (c.total || 0) - poolSize()) + "</b></span>"
    ].join("");
  }

  /* ---------- 组装 ---------- */
  function select(charId) {
    var op = null;
    for (var i = 0; i < DATA.operators.length; i++) {
      if (DATA.operators[i].charId === charId || DATA.operators[i].battleId === charId) {
        op = DATA.operators[i];
        break;
      }
    }
    if (!op) return;
    STATE.selected = op.charId;
    renderList();
    renderDetail(op);
  }

  function build(container) {
    container.innerHTML = [
      '<div class="akf-roster">',
        '<header class="akx-bar">',
          '<div class="akx-title">干员图鉴<small>全干员档案 · 属性 / 技能 / 天赋 / 攻击范围</small></div>',
          '<div class="akx-stats"></div>',
          '<div class="akx-tools">',
            '<input class="akx-search" type="search" placeholder="搜索干员 / 分支…">',
            '<div class="akx-seg">',
              '<button type="button" data-scope="all">全部</button>',
              '<button type="button" data-scope="playable">可出战</button>',
              '<button type="button" data-scope="gallery">仅图鉴</button>',
            "</div>",
            '<select class="akx-select"><option value="all">全部职业</option>' +
              Object.keys(DATA.professions).map(function (p) {
                return '<option value="' + esc(p) + '">' + esc(DATA.professions[p]) + "</option>";
              }).join("") + "</select>",
          "</div>",
        "</header>",
        '<div class="akx-main">',
          '<aside class="akx-list"></aside>',
          '<section class="akx-detail"></section>',
        "</div>",
      "</div>"
    ].join("");

    ELS.root = container.querySelector(".akf-roster");
    ELS.stats = container.querySelector(".akx-stats");
    ELS.list = container.querySelector(".akx-list");
    ELS.detail = container.querySelector(".akx-detail");
    ELS.search = container.querySelector(".akx-search");
    ELS.seg = container.querySelector(".akx-seg");
    ELS.prof = container.querySelector(".akx-select");

    renderBar();

    ELS.search.addEventListener("input", function () {
      STATE.query = ELS.search.value;
      renderList();
    });
    ELS.seg.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-scope]");
      if (!btn) return;
      STATE.scope = btn.getAttribute("data-scope");
      Array.prototype.forEach.call(ELS.seg.querySelectorAll("button"), function (b) {
        b.classList.toggle("on", b === btn);
      });
      renderList();
    });
    ELS.prof.addEventListener("change", function () {
      STATE.profession = ELS.prof.value;
      renderList();
    });
    ELS.list.addEventListener("click", function (e) {
      var row = e.target.closest(".akx-row");
      if (row) select(row.getAttribute("data-char"));
    });
    ELS.seg.querySelector('button[data-scope="all"]').classList.add("on");
  }

  function render(container, options) {
    options = options || {};
    if (!container) return Promise.reject(new Error("AKF_ROSTER.render: container 为空"));
    // 对战池集合：由调用方传入当前对战池干员（battleId 或 charId），未传则用数据内标记
    POOL = (options.playable && typeof options.playable.has === "function") ? options.playable : null;

    var ready = (options.data ? Promise.resolve(options.data) :
      fetch(options.dataUrl || "roster-data.json")
        .then(function (r) {
          if (!r.ok) throw new Error("roster-data.json 加载失败 HTTP " + r.status);
          return r.json();
        })
    ).then(function (data) {
      DATA = data;
      build(container);
      var want = options.select || null;
      if (!want) {
        var m = /[?&]char=([^&]+)/.exec(window.location.search || "");
        want = m ? decodeURIComponent(m[1]) : null;
      }
      var first = want || (DATA.operators[0] && DATA.operators[0].charId);
      if (first) select(first);
      // 自查辅助：定位到详情某个分节（options.scrollTo 或 ?scroll=skills）
      var sec = options.scrollTo || null;
      if (!sec) {
        var sm = /[?&]scroll=([^&]+)/.exec(window.location.search || "");
        sec = sm ? decodeURIComponent(sm[1]) : null;
      }
      if (sec) {
        var target = ELS.detail.querySelector('[data-sec="' + sec + '"]');
        if (target) {
          var delta = target.getBoundingClientRect().top -
            ELS.detail.getBoundingClientRect().top;
          ELS.detail.scrollTop = Math.max(0, ELS.detail.scrollTop + delta - 12);
        }
      }
      return container;
    }).catch(function (err) {
      container.innerHTML = '<div class="akx-error">干员图鉴数据加载失败，请刷新页面重试。</div>';
      throw err;
    });

    window.AKF_ROSTER.ready = ready;
    return ready;
  }

  window.AKF_ROSTER = {
    render: render,
    counts: counts,
    ready: null
  };
})();

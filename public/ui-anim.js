/* ==========================================================================
   ArkFights · 纯 UI 动效层（ui-anim.js）
   只给界面加“轻”动效，不触碰任何玩法 / 网络 / 状态逻辑：
     1. 页面 / 面板进入：轻微上滑淡入（分组渐进）
     2. 按钮 hover：高光扫过
     3. 选中卡片：金色呼吸描边（CSS）+ 选中瞬间轻挑
     4. 数字变化：短暂高亮
     5. toast：上浮
   全部尊重系统设置 prefers-reduced-motion（关闭后一律静默）。
   ========================================================================== */
(function () {
  "use strict";

  /* ---------- 减少动态效果 ---------- */
  var mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  function reduced() { return !!(mq && mq.matches); }
  function syncReduceFlag() {
    document.documentElement.classList.toggle("ak-reduce-motion", reduced());
  }
  syncReduceFlag();
  if (mq) {
    if (mq.addEventListener) mq.addEventListener("change", syncReduceFlag);
    else if (mq.addListener) mq.addListener(syncReduceFlag);
  }

  /* ---------- 缺图降级（纯视觉：不留浏览器碎图图标） ---------- */
  document.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t.tagName === "IMG" && t.classList) {
      t.classList.add("ak-img-missing");
      if (t.getAttribute("src")) t.removeAttribute("src");
    }
  }, true);

  /* ---------- 公共：动画类用完即摘，避免残留影响样式 ---------- */
  var ONE_SHOT = ["ak-in", "ak-shine", "ak-num-flash", "ak-toast-in", "ak-sel-pop"];
  document.addEventListener("animationend", function (e) {
    var el = e.target;
    if (!el || !el.classList) return;
    ONE_SHOT.forEach(function (cls) {
      if (el.classList.contains(cls)) {
        el.classList.remove(cls);
        if (cls === "ak-in") el.style.animationDelay = "";
      }
    });
  }, true);

  /* ---------- 1. 页面 / 面板进入：轻微上滑淡入 ---------- */
  var ENTER_SEL = [
    ".akTop", ".akSide", ".kvArea", ".kvTitle", ".kvArt", ".akEntryRow", ".akRoomBar", ".akFooter",
    ".roomPanel", ".roomAside", ".roomPlayers",
    ".subTop", ".configBody", ".guideBody", ".rosterRoot",
    ".draftTop", ".squadCol", ".draftPoolWrap", ".poolStatus", ".draftAction",
    ".mpCard", ".resultCard", ".mapPick", ".poolGroup",
    ".btTop", ".btHand", ".btFloat", ".unitOverlay .uoStats", ".unitOverlay .uoSkill", ".unitOverlay .uoTabs"
  ].join(",");
  var lastEnterAt = 0;
  var homeSeen = false;

  function collectEnter(scope, limit) {
    var out = [];
    if (!scope || !scope.querySelectorAll) return out;
    if (scope.matches && scope.matches(ENTER_SEL)) out.push(scope);
    var found = scope.querySelectorAll(ENTER_SEL);
    for (var i = 0; i < found.length && out.length < limit; i += 1) out.push(found[i]);
    return out;
  }

  function playEnter(scope, fast) {
    if (reduced() || !scope) return;
    var now = Date.now();
    if (now - lastEnterAt < 320) return;          // 连续切屏时不叠加
    lastEnterAt = now;
    var items = collectEnter(scope, 12);
    items.forEach(function (el, i) {
      el.classList.remove("ak-in");
      void el.offsetWidth;                        // 强制重排，保证可重复触发
      // 快速模式（首屏）：不做渐进延迟，保证切换瞬间内容即刻可读
      el.style.animationDelay = fast ? "0ms" : (Math.min(i, 9) * 30 + "ms");
      el.classList.add("ak-in");
      // 兜底：动画中断（display 切换等）也要恢复可见
      window.setTimeout(function () {
        if (el.classList.contains("ak-in")) {
          el.classList.remove("ak-in");
          el.style.animationDelay = "";
        }
      }, fast ? 420 : 900);
    });
  }

  /* 屏幕 / 浮层显隐 → 触发进入动画 */
  function watchVisibility() {
    if (typeof MutationObserver === "undefined") return;
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i += 1) {
        var el = muts[i].target;
        if (!el || !el.classList || el.classList.contains("hidden")) continue;
        // 主页在加载流程结束后才出现：用快速淡入，避免切换瞬间“空屏”
        var fast = el.id === "homeScreen" && !homeSeen;
        if (el.id === "homeScreen") homeSeen = true;
        playEnter(el, fast);
      }
    });
    var sel = ".screen, #mapPreview, #resultOverlay, #unitOverlay";
    document.querySelectorAll(sel).forEach(function (el) {
      obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    });
  }

  /* ---------- 2. 按钮 hover：禁用高光扫过效果 ---------- */
  // 已移除：原金属闪烁光标效果不够精致，改为纯 CSS 过渡

  /* ---------- 3. 选中卡片：瞬间轻挑（呼吸描边在 CSS 里） ---------- */
  function watchSelection() {
    if (typeof MutationObserver === "undefined") return;
    var obs = new MutationObserver(function (muts) {
      if (reduced()) return;
      for (var i = 0; i < muts.length; i += 1) {
        var el = muts[i].target;
        if (!el || !el.classList) continue;
        var selected = el.classList.contains("preselect") || el.classList.contains("active");
        if (selected && !el.classList.contains("ak-sel-pop")) {
          el.classList.add("ak-sel-pop");
        }
      }
    });
    var sel = ".poolCard, .handButton, .mapPick, .squadCard, .akSideItem";
    document.querySelectorAll(sel).forEach(function (el) {
      obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    });
  }

  /* ---------- 4. 数字变化：短暂高亮 ---------- */
  var NUM_IDS = [
    "cost", "blueHp", "enemyHp", "deploySlots", "draftCap", "draftCount",
    "uoAtk", "uoDef", "uoRes", "uoBlock", "uoHp",
    "resultTime", "resultBlueHp", "resultRedHp"
  ];
  function flash(el) {
    if (reduced() || !el || !el.classList) return;
    el.classList.remove("ak-num-flash");
    void el.offsetWidth;
    el.classList.add("ak-num-flash");
  }
  function watchNumbers() {
    if (typeof MutationObserver === "undefined") return;
    var roots = new Set();
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i += 1) {
        var t = muts[i].target;
        var el = t && t.nodeType === 1 ? t : (t && t.parentElement);
        while (el && !roots.has(el)) el = el.parentElement;
        flash(el);
      }
    });
    NUM_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      roots.add(el);
      obs.observe(el, { characterData: true, childList: true, subtree: true });
    });
  }

  /* ---------- 5. toast：上浮 ---------- */
  function watchToast() {
    if (typeof MutationObserver === "undefined") return;
    var area = document.getElementById("toastArea");
    if (!area) return;
    new MutationObserver(function (muts) {
      if (reduced()) return;
      for (var i = 0; i < muts.length; i += 1) {
        var nodes = muts[i].addedNodes;
        for (var j = 0; j < nodes.length; j += 1) {
          var n = nodes[j];
          if (n.nodeType === 1 && n.classList) {
            n.classList.remove("ak-toast-in");
            void n.offsetWidth;
            n.classList.add("ak-toast-in");
          }
        }
      }
    }).observe(area, { childList: true });
  }

  /* ---------- 启动 ---------- */
  function boot() {
    watchVisibility();
    watchSelection();
    watchNumbers();
    watchToast();
    // 当前可见的屏幕先来一遍（加载页；主页若已在则走快速淡入）
    document.querySelectorAll(".screen:not(.hidden)").forEach(function (el) {
      var fast = el.id === "homeScreen";
      if (fast) homeSeen = true;
      playEnter(el, fast);
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

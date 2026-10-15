// 战斗内FPS监控（按F12开启，显示在左上角）
// 用法：战斗中按 F12，屏幕左上角显示 FPS / 帧时间 / 特效数
(function() {
  let enabled = false;
  let frameT = [];
  let lastT = performance.now();
  const div = document.createElement('div');
  div.id = 'fpsMonitor';
  div.style.cssText = 'position:fixed;top:10px;left:10px;background:rgba(0,0,0,0.8);color:#0f0;font:bold 12px Consolas;padding:8px;z-index:9999;border-radius:4px;display:none;';
  document.body.appendChild(div);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12') {
      e.preventDefault();
      enabled = !enabled;
      div.style.display = enabled ? 'block' : 'none';
      if (enabled) frameT = [];
    }
  });

  function update() {
    if (!enabled) { requestAnimationFrame(update); return; }
    const now = performance.now();
    const dt = now - lastT;
    lastT = now;
    frameT.push(dt);
    if (frameT.length > 60) frameT.shift();

    const avg = frameT.reduce((s, t) => s + t, 0) / frameT.length;
    const fps = (1000 / avg).toFixed(1);
    const p95 = frameT.slice().sort((a, b) => a - b)[Math.floor(frameT.length * 0.95)];
    
    const fxState = window.fxState;
    let fxCount = 0;
    if (fxState) {
      for (const k of ['slashes','shots','bolts','blooms','pulses','rings','casts','hits','floats','bubbles','deaths']) {
        fxCount += (fxState[k] || []).length;
      }
    }
    
    div.innerHTML = `FPS: ${fps} (P95: ${(1000 / p95).toFixed(1)})<br>Frame: ${avg.toFixed(1)}ms (P95: ${p95.toFixed(1)}ms)<br>FX: ${fxCount}`;
    
    requestAnimationFrame(update);
  }
  update();
})();

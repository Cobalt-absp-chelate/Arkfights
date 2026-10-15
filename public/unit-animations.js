// 干员移动动画系统
// 为无Spine模型的干员添加简单的移动动画

const UnitMovementAnimation = {
  // 存储每个单位的动画状态
  states: new Map(),
  
  // 初始化单位动画状态
  initUnit(unitId) {
    if (!this.states.has(unitId)) {
      this.states.set(unitId, {
        walkCycle: 0,           // 行走周期 (0-1)
        legOffset: 0,           // 腿部偏移
        bobOffset: 0,           // 上下浮动
        lastX: 0,
        lastY: 0,
        isMoving: false,
        moveSpeed: 0,
      });
    }
  },
  
  // 更新单位动画
  update(unit, dt) {
    this.initUnit(unit.id);
    const state = this.states.get(unit.id);
    
    // 检测移动
    const dx = unit.x - state.lastX;
    const dy = unit.y - state.lastY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    state.isMoving = distance > 0.001;
    state.moveSpeed = distance / dt;
    
    if (state.isMoving) {
      // 更新行走周期（速度越快，周期越快）
      const cycleSpeed = Math.min(state.moveSpeed * 2, 8);
      state.walkCycle += cycleSpeed * dt;
      if (state.walkCycle > 1) state.walkCycle -= 1;
      
      // 腿部摆动（正弦波）
      state.legOffset = Math.sin(state.walkCycle * Math.PI * 2) * 0.15;
      
      // 上下浮动（行走时的弹跳）
      state.bobOffset = Math.abs(Math.sin(state.walkCycle * Math.PI * 2)) * 0.05;
    } else {
      // 停止时平滑回归
      state.walkCycle *= 0.9;
      state.legOffset *= 0.9;
      state.bobOffset *= 0.9;
    }
    
    state.lastX = unit.x;
    state.lastY = unit.y;
    
    return state;
  },
  
  // 绘制带动画的干员（替代drawUnitCard）
  drawAnimatedUnit(ctx, cam, unit, op) {
    const state = this.update(unit, 1/60); // 假设60fps
    
    const z = heightAt(Math.round(unit.x), Math.round(unit.y));
    const foot = cam.project(unit.x, unit.y, z + state.bobOffset);
    const s = foot.s;
    
    ctx.save();
    ctx.translate(foot.x, foot.y);
    
    // 身体（圆形，稍微上移）
    const bodyY = -0.3 * s;
    ctx.beginPath();
    ctx.arc(0, bodyY, s * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = unit.team === 'blue' ? '#5ec5ff' : '#ff6a5a';
    ctx.globalAlpha = 0.9;
    ctx.fill();
    
    // 如果在移动，绘制简单的腿部
    if (state.isMoving && Math.abs(state.legOffset) > 0.01) {
      ctx.strokeStyle = unit.team === 'blue' ? '#4aa8dd' : '#dd5040';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      
      // 左腿
      ctx.beginPath();
      ctx.moveTo(0, bodyY + s * 0.2);
      ctx.lineTo(-s * 0.15 + state.legOffset * s, s * 0.1);
      ctx.stroke();
      
      // 右腿
      ctx.beginPath();
      ctx.moveTo(0, bodyY + s * 0.2);
      ctx.lineTo(s * 0.15 - state.legOffset * s, s * 0.1);
      ctx.stroke();
    }
    
    // 名字
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.round(s * 0.25)}px Microsoft YaHei`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const name = op.name || '';
    ctx.fillText(name.slice(0, 2), 0, bodyY);
    
    ctx.restore();
  },
  
  // 清理不存在的单位
  cleanup(activeUnitIds) {
    const idsToDelete = [];
    for (const id of this.states.keys()) {
      if (!activeUnitIds.includes(id)) {
        idsToDelete.push(id);
      }
    }
    for (const id of idsToDelete) {
      this.states.delete(id);
    }
  },
};

// 转向动画（平滑旋转）
const UnitRotationAnimation = {
  states: new Map(),
  
  initUnit(unitId, facing) {
    if (!this.states.has(unitId)) {
      this.states.set(unitId, {
        currentAngle: this.facingToAngle(facing),
        targetAngle: this.facingToAngle(facing),
        rotationSpeed: 5, // 弧度/秒
      });
    }
  },
  
  facingToAngle(facing) {
    // 将朝向向量转为角度
    if (!facing) return 0;
    return Math.atan2(facing.y, facing.x);
  },
  
  update(unitId, facing, dt) {
    this.initUnit(unitId, facing);
    const state = this.states.get(unitId);
    
    state.targetAngle = this.facingToAngle(facing);
    
    // 平滑插值到目标角度
    let diff = state.targetAngle - state.currentAngle;
    
    // 归一化到 -π 到 π
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    
    if (Math.abs(diff) > 0.01) {
      const step = Math.sign(diff) * Math.min(Math.abs(diff), state.rotationSpeed * dt);
      state.currentAngle += step;
    }
    
    return state.currentAngle;
  },
  
  cleanup(activeUnitIds) {
    const idsToDelete = [];
    for (const id of this.states.keys()) {
      if (!activeUnitIds.includes(id)) {
        idsToDelete.push(id);
      }
    }
    for (const id of idsToDelete) {
      this.states.delete(id);
    }
  },
};

// 缓动函数库
const Easing = {
  // 线性
  linear: t => t,
  
  // 二次方
  easeInQuad: t => t * t,
  easeOutQuad: t => t * (2 - t),
  easeInOutQuad: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  
  // 三次方
  easeInCubic: t => t * t * t,
  easeOutCubic: t => (--t) * t * t + 1,
  easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  
  // 弹性
  easeOutElastic: t => {
    const p = 0.3;
    return Math.pow(2, -10 * t) * Math.sin((t - p / 4) * (2 * Math.PI) / p) + 1;
  },
  
  // 回弹
  easeOutBounce: t => {
    if (t < 1 / 2.75) {
      return 7.5625 * t * t;
    } else if (t < 2 / 2.75) {
      return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
    } else if (t < 2.5 / 2.75) {
      return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
    } else {
      return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
    }
  },
};

// 位移动画（用于高台下地等）
const UnitTeleportAnimation = {
  animations: new Map(),
  
  startTeleport(unitId, fromPos, toPos, duration = 0.5) {
    this.animations.set(unitId, {
      fromX: fromPos.x,
      fromY: fromPos.y,
      toX: toPos.x,
      toY: toPos.y,
      duration: duration,
      elapsed: 0,
      easing: Easing.easeOutCubic,
    });
  },
  
  update(unitId, dt) {
    if (!this.animations.has(unitId)) return null;
    
    const anim = this.animations.get(unitId);
    anim.elapsed += dt;
    
    if (anim.elapsed >= anim.duration) {
      this.animations.delete(unitId);
      return null;
    }
    
    const t = anim.easing(anim.elapsed / anim.duration);
    
    return {
      x: anim.fromX + (anim.toX - anim.fromX) * t,
      y: anim.fromY + (anim.toY - anim.fromY) * t,
      z: Math.sin(t * Math.PI) * 0.3, // 抛物线
      progress: t,
    };
  },
  
  isAnimating(unitId) {
    return this.animations.has(unitId);
  },
};

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UnitMovementAnimation,
    UnitRotationAnimation,
    UnitTeleportAnimation,
    Easing,
  };
}

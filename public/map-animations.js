// 地图动画系统 - 樱花花瓣、水墨云雾等

const MAP_ANIMATIONS = {
  // 樱花花瓣飘落
  sakuraPetals: {
    particles: [],
    maxCount: 50,
    
    init() {
      this.particles = [];
      for (let i = 0; i < this.maxCount; i++) {
        this.particles.push(this.createPetal());
      }
    },
    
    createPetal() {
      return {
        x: Math.random(),
        y: Math.random() * -0.2,
        vx: (Math.random() - 0.5) * 0.0002,
        vy: 0.0001 + Math.random() * 0.0001,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.02,
        size: 0.015 + Math.random() * 0.01,
        opacity: 0.6 + Math.random() * 0.4,
        sway: Math.random() * Math.PI * 2,
        swaySpeed: 0.01 + Math.random() * 0.01,
      };
    },
    
    update(dt) {
      for (const p of this.particles) {
        // 飘落
        p.y += p.vy * dt * 60;
        p.x += p.vx * dt * 60;
        
        // 左右摇摆
        p.sway += p.swaySpeed * dt * 60;
        p.x += Math.sin(p.sway) * 0.0001 * dt * 60;
        
        // 旋转
        p.rotation += p.rotationSpeed * dt * 60;
        
        // 重置到顶部
        if (p.y > 1.2) {
          p.y = -0.1;
          p.x = Math.random();
        }
        
        // 边界循环
        if (p.x < -0.1) p.x = 1.1;
        if (p.x > 1.1) p.x = -0.1;
      }
    },
    
    render(ctx, canvasWidth, canvasHeight) {
      ctx.save();
      for (const p of this.particles) {
        const x = p.x * canvasWidth;
        const y = p.y * canvasHeight;
        const size = p.size * canvasWidth;
        
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(p.rotation);
        ctx.globalAlpha = p.opacity;
        
        // 花瓣形状（椭圆）
        ctx.fillStyle = '#ffb0d0';
        ctx.beginPath();
        ctx.ellipse(0, 0, size, size * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // 花瓣纹理
        ctx.strokeStyle = '#ffc0e0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-size * 0.5, 0);
        ctx.lineTo(size * 0.5, 0);
        ctx.stroke();
        
        ctx.restore();
      }
      ctx.restore();
    },
  },
  
  // 水墨云雾
  inkMist: {
    clouds: [],
    maxCount: 8,
    
    init() {
      this.clouds = [];
      for (let i = 0; i < this.maxCount; i++) {
        this.clouds.push(this.createCloud());
      }
    },
    
    createCloud() {
      return {
        x: Math.random(),
        y: 0.3 + Math.random() * 0.4,
        vx: 0.00005 + Math.random() * 0.00005,
        scale: 0.8 + Math.random() * 0.4,
        opacity: 0.1 + Math.random() * 0.15,
        phase: Math.random() * Math.PI * 2,
        phaseSpeed: 0.005 + Math.random() * 0.005,
      };
    },
    
    update(dt) {
      for (const c of this.clouds) {
        c.x += c.vx * dt * 60;
        c.phase += c.phaseSpeed * dt * 60;
        
        // 循环
        if (c.x > 1.2) {
          c.x = -0.2;
          c.y = 0.3 + Math.random() * 0.4;
        }
        
        // 缩放呼吸
        c.scale = 0.8 + Math.sin(c.phase) * 0.1;
      }
    },
    
    render(ctx, canvasWidth, canvasHeight) {
      ctx.save();
      for (const c of this.clouds) {
        const x = c.x * canvasWidth;
        const y = c.y * canvasHeight;
        const size = c.scale * 100;
        
        ctx.globalAlpha = c.opacity;
        
        // 云雾渐变
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
        gradient.addColorStop(0, 'rgba(180, 180, 180, 0.3)');
        gradient.addColorStop(0.5, 'rgba(150, 150, 150, 0.15)');
        gradient.addColorStop(1, 'rgba(120, 120, 120, 0)');
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        
        // 额外的云团
        ctx.beginPath();
        ctx.arc(x + size * 0.4, y - size * 0.2, size * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  },
  
  // 背景网格移动（科技感）
  techGrid: {
    offset: {x: 0, y: 0},
    speed: 0.0001,
    
    update(dt) {
      this.offset.x += this.speed * dt * 60;
      this.offset.y += this.speed * dt * 60;
      
      // 循环
      if (this.offset.x > 1) this.offset.x -= 1;
      if (this.offset.y > 1) this.offset.y -= 1;
    },
    
    render(ctx, canvasWidth, canvasHeight) {
      ctx.save();
      ctx.strokeStyle = 'rgba(100, 150, 200, 0.05)';
      ctx.lineWidth = 1;
      
      const gridSize = 50;
      const offsetX = this.offset.x * gridSize;
      const offsetY = this.offset.y * gridSize;
      
      // 垂直线
      for (let x = -gridSize + offsetX; x < canvasWidth + gridSize; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvasHeight);
        ctx.stroke();
      }
      
      // 水平线
      for (let y = -gridSize + offsetY; y < canvasHeight + gridSize; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
        ctx.stroke();
      }
      
      ctx.restore();
    },
  },
};

// 动画管理器
const AnimationManager = {
  activeAnimations: [],
  animationCanvas: null,
  animationCtx: null,
  lastFrame: 0,
  
  init(canvas) {
    this.animationCanvas = canvas;
    this.animationCtx = canvas.getContext('2d');
    this.lastFrame = performance.now();
  },
  
  startAnimation(animationName) {
    const anim = MAP_ANIMATIONS[animationName];
    if (!anim) {
      console.warn(`Animation ${animationName} not found`);
      return;
    }
    
    if (anim.init) anim.init();
    
    if (!this.activeAnimations.find(a => a.name === animationName)) {
      this.activeAnimations.push({
        name: animationName,
        anim: anim,
      });
    }
  },
  
  stopAnimation(animationName) {
    this.activeAnimations = this.activeAnimations.filter(a => a.name !== animationName);
  },
  
  clearAll() {
    this.activeAnimations = [];
  },
  
  update() {
    if (!this.animationCanvas || !this.animationCtx) return;
    
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    
    // 更新所有动画
    for (const {anim} of this.activeAnimations) {
      if (anim.update) anim.update(dt);
    }
    
    // 渲染
    this.render();
  },
  
  render() {
    const ctx = this.animationCtx;
    const canvas = this.animationCanvas;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    for (const {anim} of this.activeAnimations) {
      if (anim.render) {
        anim.render(ctx, canvas.width, canvas.height);
      }
    }
  },
};

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {MAP_ANIMATIONS, AnimationManager};
}

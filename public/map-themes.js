// 地图主题配置系统 - 5图差异化色调与材质
// 替代原有单一深色调，每张地图有独特视觉风格

const MAP_THEMES = {
  training: {
    name: "训练场",
    mood: "清爽教学",
    colors: {
      // 浅灰混凝土 + 青色调
      ground: "#8a95a0",      // 地面：浅灰
      platform: "#6b8aa6",    // 高台：青灰金属
      wall: "#5a6670",        // 障碍：深灰
      path: "#99a5af",        // 通路：更浅灰
      ambient: "rgba(180,200,220,0.15)", // 环境光：冷白
    },
    light: {
      groundTint: "rgba(160,170,180,0.85)",
      platformTint: "rgba(140,165,190,0.90)", // 高台偏蓝
      pathTint: "rgba(170,180,190,0.80)",
      wallTint: "rgba(100,110,120,0.95)",
      colorTemp: "rgba(200,220,240,0.08)",
    },
    decor: {
      primary: "#7a8a9a",
      secondary: "#9aabb8",
      dark: "#4a5560",
    },
    style: "concrete", // 混凝土质感
  },

  cross: {
    name: "十字路口",
    mood: "荒漠前哨",
    colors: {
      // 浅棕沙地 + 暖黄调
      ground: "#b8a890",      // 沙地：浅棕
      platform: "#9a8570",    // 高台：棕色木板
      wall: "#6a5a48",        // 障碍：深棕
      path: "#c8b8a0",        // 通路：浅沙色
      ambient: "rgba(255,235,200,0.12)",
    },
    light: {
      groundTint: "rgba(200,185,160,0.80)",
      platformTint: "rgba(170,150,130,0.88)", // 高台木质感
      pathTint: "rgba(210,195,170,0.75)",
      wallTint: "rgba(110,95,75,0.95)",
      colorTemp: "rgba(255,240,210,0.10)",
    },
    decor: {
      primary: "#a89070",
      secondary: "#c8b090",
      dark: "#5a4a38",
    },
    style: "sand", // 沙土质感
  },

  lanes: {
    name: "通路",
    mood: "科技实验室",
    colors: {
      // 白色金属 + 冷蓝调
      ground: "#b0b8c8",      // 地面：浅蓝灰
      platform: "#90a8c8",    // 高台：蓝色金属格栅
      wall: "#6a7888",        // 障碍：冷灰
      path: "#c0c8d8",        // 通路：白蓝
      ambient: "rgba(180,200,240,0.18)",
    },
    light: {
      groundTint: "rgba(190,200,220,0.82)",
      platformTint: "rgba(160,185,220,0.92)", // 高台金属蓝
      pathTint: "rgba(200,210,230,0.78)",
      wallTint: "rgba(110,120,140,0.95)",
      colorTemp: "rgba(200,220,255,0.12)",
    },
    decor: {
      primary: "#8a9ab0",
      secondary: "#aabbd0",
      dark: "#5a6a80",
    },
    style: "metal", // 金属质感
  },

  ridge: {
    name: "山脊",
    mood: "丛林高地",
    colors: {
      // 深绿植被 + 自然绿调
      ground: "#6a7860",      // 地面：深绿灰
      platform: "#5a6858",    // 高台：暗绿岩石
      wall: "#4a5448",        // 障碍：深绿
      path: "#7a8870",        // 通路：浅绿
      ambient: "rgba(160,180,150,0.14)",
    },
    light: {
      groundTint: "rgba(120,135,115,0.88)",
      platformTint: "rgba(100,115,100,0.92)", // 高台岩石质感
      pathTint: "rgba(130,145,125,0.82)",
      wallTint: "rgba(75,85,70,0.95)",
      colorTemp: "rgba(180,200,160,0.09)",
    },
    decor: {
      primary: "#6a7a60",
      secondary: "#8a9a80",
      dark: "#3a4438",
    },
    style: "stone", // 岩石质感
  },

  frontier: {
    name: "前线",
    mood: "边境峡谷",
    colors: {
      // 粉橙岩石 + 落日橙调
      ground: "#a88870",      // 地面：橙棕
      platform: "#9a7058",    // 高台：暗橙岩石
      wall: "#6a5040",        // 障碍：深棕
      path: "#b89880",        // 通路：浅橙
      ambient: "rgba(255,200,160,0.16)",
    },
    light: {
      groundTint: "rgba(180,145,120,0.85)",
      platformTint: "rgba(160,120,95,0.90)", // 高台岩石橙
      pathTint: "rgba(190,155,130,0.80)",
      wallTint: "rgba(105,80,60,0.95)",
      colorTemp: "rgba(255,220,180,0.11)",
    },
    decor: {
      primary: "#988060",
      secondary: "#b8a080",
      dark: "#5a4030",
    },
    style: "rock", // 粗糙岩石
  },
};

// 获取当前地图主题
function getMapTheme(mapId) {
  return MAP_THEMES[mapId] || MAP_THEMES.training;
}

// 导出供 app.js 使用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MAP_THEMES, getMapTheme };
}

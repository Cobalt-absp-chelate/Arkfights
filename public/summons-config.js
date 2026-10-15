// 召唤物配置数据（手动配置典型案例）
// 基于明日方舟wiki和游戏实际效果

const SUMMON_CONFIGS = {
  // 夕 - 封天雷（手牌型）
  "char_436_whispr": {
    charName: "夕",
    summons: [{
      kind: "dusk_painting",
      type: "hand",
      triggerOn: "deploy",
      initialCount: 3,
      maxCount: 5,
      onSkillAdd: {
        skillIndex: 2,
        addCount: 2,
      },
      deployRules: {
        anywhere: true,
        blockTerrain: false,
      },
      stats: {
        hp: 0,
        atk: 0,
        duration: 15,
        auraType: "slow",
        auraRange: 2.0,
        auraPower: 0.6,
      },
      visual: {
        type: "painting",
        color: "#d4a5d8",
        scale: 1.2,
        icon: "🎨",
      }
    }]
  },

  // 维什戴尔 - 结晶（场上型，数量递增）
  "char_279_excu": {
    charName: "维什戴尔",
    summons: [{
      kind: "weedy_crystal",
      type: "field",
      triggerOn: "deploy",
      progressive: true,
      counts: {
        0: 1,
        1: 2,
        2: 3,
      },
      spawnPosition: "adjacent",
      stats: {
        hp: 0,
        atk: 0,
        blockTerrain: true,
        grantsBuff: {
          def: 0.3,
          range: 1.5,
        },
      },
      visual: {
        type: "crystal",
        color: "#6ac5e8",
        scale: 0.8,
        icon: "💎",
      }
    }]
  },

  // 罗宾 - 侦察弩炮（手牌型，触发型）
  "char_4025_robin": {
    charName: "罗宾",
    summons: [{
      kind: "robin_trap",
      type: "hand",
      triggerOn: "deploy",
      initialCount: 3,
      maxCount: 3,
      deployRules: {
        groundOnly: true,
        blockTerrain: false,
      },
      stats: {
        hp: 50,
        atk: 400,
        triggerType: "proximity",
        triggerRange: 1.2,
        oneShot: true,
        duration: 60,
      },
      visual: {
        type: "trap",
        color: "#e8a06a",
        scale: 0.6,
        icon: "💣",
      }
    }]
  },

  // 森蚺 - 机械装置（场上型）
  "char_472_pasngr": {
    charName: "森蚺",
    summons: [{
      kind: "eunectes_device",
      type: "field",
      triggerOn: "skill",
      skillIndex: 2,
      maxCount: 1,
      spawnPosition: "adjacent",
      stats: {
        hp: 300,
        atk: 200,
        def: 100,
        range: 1.5,
        duration: 30,
      },
      visual: {
        type: "device",
        color: "#8ac58a",
        scale: 1.0,
        icon: "⚙️",
      }
    }]
  },

  // 麦哲伦 - 无人机（场上型，可召回）
  "char_2013_cerber": {
    charName: "麦哲伦",
    summons: [{
      kind: "magallan_drone",
      type: "field",
      triggerOn: "skill",
      skillIndex: 1,
      count: 3,
      spawnPosition: "adjacent",
      recallable: true,
      stats: {
        hp: 200,
        atk: 150,
        def: 0,
        range: 2.5,
        speed: 1.2,
        behavior: "follow",
        damageType: "arts",
        canBeHealed: true,
      },
      visual: {
        type: "drone",
        color: "#5ec5ff",
        scale: 0.7,
        icon: "🛸",
      }
    }]
  },

  // 凯尔希 - Mon3tr（场上型，独立单位）
  "char_2014_nian": {
    charName: "凯尔希",
    summons: [{
      kind: "mon3tr",
      type: "field",
      triggerOn: "deploy",
      maxCount: 1,
      spawnPosition: "adjacent",
      stats: {
        hp: 800,
        atk: 300,
        def: 200,
        range: 1.0,
        blockCount: 1,
        behavior: "static",
        canBeHealed: true,
        linkedToSummoner: true,
      },
      visual: {
        type: "mon3tr",
        color: "#6a8a6a",
        scale: 1.5,
        icon: "🦎",
      }
    }]
  },

  // 泥岩 - 泥偶（场上型，坦克）
  "char_311_mudrok": {
    charName: "泥岩",
    summons: [{
      kind: "mudrock_colossus",
      type: "field",
      triggerOn: "skill",
      skillIndex: 2,
      maxCount: 1,
      spawnPosition: "adjacent",
      stats: {
        hp: 1500,
        atk: 200,
        def: 300,
        blockCount: 2,
        behavior: "static",
        canBeHealed: true,
        taunt: true,
      },
      visual: {
        type: "golem",
        color: "#8a7a6a",
        scale: 1.8,
        icon: "🗿",
      }
    }]
  },

  // 琴柳 - 庇护所（手牌型）
  "char_2015_dusk": {
    charName: "琴柳",
    summons: [{
      kind: "scene_sanctuary",
      type: "hand",
      triggerOn: "skill",
      skillIndex: 2,
      initialCount: 1,
      maxCount: 1,
      deployRules: {
        groundOnly: true,
        blockTerrain: true,
      },
      stats: {
        hp: 500,
        atk: 0,
        duration: 25,
        healAura: 100,
        auraRange: 1.5,
      },
      visual: {
        type: "sanctuary",
        color: "#a8d8c8",
        scale: 1.2,
        icon: "🏠",
      }
    }]
  },

  // 絮雨 - 诅咒娃娃（场上型）
  "char_346_aosta": {
    charName: "絮雨",
    summons: [{
      kind: "shamare_doll",
      type: "field",
      triggerOn: "skill",
      skillIndex: 1,
      maxCount: 1,
      spawnPosition: "adjacent",
      stats: {
        hp: 0,
        atk: 0,
        duration: 18,
        debuffAura: {
          atk: -0.4,
          def: -0.3,
          range: 2.5,
        },
      },
      visual: {
        type: "doll",
        color: "#d890c8",
        scale: 0.6,
        icon: "🪆",
      }
    }]
  },

  // 巫恋 - 石柱（手牌型）
  "char_379_sesa": {
    charName: "巫恋",
    summons: [{
      kind: "beeswax_obelisk",
      type: "hand",
      triggerOn: "skill",
      skillIndex: 2,
      initialCount: 2,
      maxCount: 4,
      deployRules: {
        groundOnly: true,
        blockTerrain: true,
      },
      stats: {
        hp: 800,
        atk: 0,
        def: 500,
        duration: 30,
        blockCount: 1,
      },
      visual: {
        type: "obelisk",
        color: "#c8a878",
        scale: 1.0,
        icon: "🗼",
      }
    }]
  },

  // 陈 - 火龙（场上型，特效）
  "char_010_chen": {
    charName: "陈",
    summons: [{
      kind: "chen_dragon",
      type: "field",
      triggerOn: "skill",
      skillIndex: 2,
      maxCount: 1,
      spawnPosition: "front",
      stats: {
        hp: 0,
        atk: 800,
        behavior: "charge",
        chargeSpeed: 3.0,
        piercing: true,
        duration: 2,
      },
      visual: {
        type: "dragon",
        color: "#ff6a4a",
        scale: 2.0,
        icon: "🐉",
      }
    }]
  },

  // 艾雅法拉 - 火山（手牌型）
  "char_180_amgoat": {
    charName: "艾雅法拉",
    summons: [{
      kind: "eyja_volcano",
      type: "hand",
      triggerOn: "skill",
      skillIndex: 2,
      initialCount: 1,
      maxCount: 1,
      deployRules: {
        anywhere: true,
        blockTerrain: false,
      },
      stats: {
        hp: 0,
        atk: 0,
        behavior: "eruption",
        eruptInterval: 2.0,
        eruptDamage: 600,
        eruptRange: 2.5,
        damageType: "arts",
        duration: 15,
      },
      visual: {
        type: "volcano",
        color: "#ff8a4a",
        scale: 1.5,
        icon: "🌋",
      }
    }]
  },

  // 铃兰 - 狐火（场上型）
  "char_2013_cerber": {
    charName: "铃兰",
    summons: [{
      kind: "suzuran_foxfire",
      type: "field",
      triggerOn: "skill",
      skillIndex: 2,
      count: 3,
      spawnPosition: "orbit",
      stats: {
        hp: 0,
        atk: 0,
        behavior: "orbit",
        orbitRadius: 2.0,
        orbitSpeed: 1.5,
        passiveDamage: 50,
        debuff: {
          fragile: 0.3,
        },
        duration: 20,
      },
      visual: {
        type: "foxfire",
        color: "#ffa8d8",
        scale: 0.5,
        icon: "🔥",
      }
    }]
  },
};

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUMMON_CONFIGS };
}

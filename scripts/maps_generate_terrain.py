#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
地图地形生成工具
为非对称地图生成完整的地形数据
"""

import json
from pathlib import Path

def generate_fortress_giant():
    """生成巨型要塞地形 (40×30)"""
    width, height = 40, 30
    terrain = [[0 for _ in range(width)] for _ in range(height)]
    
    # 基础地面（大部分区域）
    for y in range(height):
        for x in range(width):
            terrain[y][x] = 1  # 默认地面
    
    # 蓝方区域（左侧）
    for y in range(6, 24):
        for x in range(0, 12):
            terrain[y][x] = 1
    
    # 红方区域（右侧）
    for y in range(3, 27):
        for x in range(28, 40):
            terrain[y][x] = 1
    
    # 中央战场
    for y in range(8, 22):
        for x in range(12, 28):
            terrain[y][x] = 1
    
    # 高台区域
    # 蓝方中央高台
    for y in range(12, 18):
        for x in range(8, 12):
            terrain[y][x] = 2
    
    # 北侧高台
    for y in range(8, 11):
        for x in range(28, 31):
            terrain[y][x] = 2
    
    # 南侧高台
    for y in range(19, 22):
        for x in range(28, 31):
            terrain[y][x] = 2
    
    # 障碍物（墙）
    for y in range(8, 10):
        for x in range(18, 22):
            terrain[y][x] = 3
    
    for y in range(20, 22):
        for x in range(18, 22):
            terrain[y][x] = 3
    
    # 中央分隔障碍
    for y in range(13, 17):
        for x in range(20, 21):
            terrain[y][x] = 3
    
    return terrain

def generate_sakura_garden():
    """生成樱花园地形 (35×28)"""
    width, height = 35, 28
    terrain = [[0 for _ in range(width)] for _ in range(height)]
    
    # 基础地面
    for y in range(height):
        for x in range(width):
            terrain[y][x] = 1
    
    # 蓝方区域
    for y in range(8, 20):
        for x in range(0, 8):
            terrain[y][x] = 1
    
    # 红方区域
    for y in range(5, 23):
        for x in range(27, 35):
            terrain[y][x] = 1
    
    # 中央道路
    for y in range(6, 22):
        for x in range(8, 27):
            terrain[y][x] = 1
    
    # 高台（中央观景台）
    for y in range(12, 16):
        for x in range(10, 13):
            terrain[y][x] = 2
    
    for y in range(12, 16):
        for x in range(22, 25):
            terrain[y][x] = 2
    
    # 北侧高台
    for y in range(10, 12):
        for x in range(22, 25):
            terrain[y][x] = 2
    
    # 南侧高台
    for y in range(16, 18):
        for x in range(22, 25):
            terrain[y][x] = 2
    
    # 樱花树位置标记（用地面表示，装饰在渲染时添加）
    # 不影响行走
    
    return terrain

def generate_ink_landscape():
    """生成水墨山水地形 (32×26)"""
    width, height = 32, 26
    terrain = [[0 for _ in range(width)] for _ in range(height)]
    
    # 基础地面
    for y in range(height):
        for x in range(width):
            terrain[y][x] = 1
    
    # 蓝方区域
    for y in range(7, 20):
        for x in range(0, 6):
            terrain[y][x] = 1
    
    # 红方区域
    for y in range(9, 17):
        for x in range(26, 32):
            terrain[y][x] = 1
    
    # 中央溪流道路
    for y in range(8, 18):
        for x in range(6, 26):
            terrain[y][x] = 1
    
    # 中央主峰（关键高地）
    for y in range(11, 15):
        for x in range(14, 18):
            terrain[y][x] = 2
    
    # 西侧山石
    for y in range(10, 12):
        for x in range(6, 9):
            terrain[y][x] = 2
    
    # 东侧山石
    for y in range(12, 14):
        for x in range(23, 26):
            terrain[y][x] = 2
    
    # 山障（不可通行）
    for y in range(8, 11):
        for x in range(10, 12):
            terrain[y][x] = 3
    
    for y in range(16, 19):
        for x in range(10, 12):
            terrain[y][x] = 3
    
    return terrain

def generate_divided_battlefield():
    """生成分裂战场地形 (38×32)"""
    width, height = 38, 32
    terrain = [[0 for _ in range(width)] for _ in range(height)]
    
    # 基础地面
    for y in range(height):
        for x in range(width):
            terrain[y][x] = 1
    
    # 蓝方中央大区域
    for y in range(10, 22):
        for x in range(0, 12):
            terrain[y][x] = 1
    
    # 六条通道
    lanes = [
        (5, 7, 12, 38),    # 第一线
        (10, 10, 12, 38),  # 第二线
        (15, 15, 12, 38),  # 第三线
        (17, 17, 12, 38),  # 第四线
        (22, 22, 12, 38),  # 第五线
        (27, 27, 12, 38),  # 第六线
    ]
    
    for y1, y2, x1, x2 in lanes:
        for y in range(y1, y2 + 1):
            for x in range(x1, x2):
                terrain[y][x] = 1
    
    # 红方6个小区域
    red_zones = [
        (3, 7, 32, 36),    # 远北
        (8, 12, 32, 36),   # 北
        (13, 17, 32, 36),  # 中北
        (18, 22, 32, 36),  # 中南
        (23, 27, 32, 36),  # 南
        (28, 30, 32, 36),  # 远南
    ]
    
    for y1, y2, x1, x2 in red_zones:
        for y in range(y1, y2 + 1):
            for x in range(x1, x2):
                terrain[y][x] = 1
    
    # 高台（战略要地）
    for y in range(14, 18):
        for x in range(18, 22):
            terrain[y][x] = 2
    
    # 障碍分隔
    for y in range(8, 10):
        for x in range(20, 22):
            terrain[y][x] = 3
    
    for y in range(22, 24):
        for x in range(20, 22):
            terrain[y][x] = 3
    
    return terrain

def main():
    """主函数"""
    output_dir = Path(__file__).parent.parent / "public"
    
    maps = {
        "fortress_giant": {
            "terrain": generate_fortress_giant(),
            "width": 40,
            "height": 30,
        },
        "sakura_garden": {
            "terrain": generate_sakura_garden(),
            "width": 35,
            "height": 28,
        },
        "ink_landscape": {
            "terrain": generate_ink_landscape(),
            "width": 32,
            "height": 26,
        },
        "divided_battlefield": {
            "terrain": generate_divided_battlefield(),
            "width": 38,
            "height": 32,
        },
    }
    
    for map_id, data in maps.items():
        output_file = output_dir / f"{map_id}_terrain.json"
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"✓ Generated {map_id}: {data['width']}×{data['height']}")
    
    print(f"\n✓ All terrain data saved to {output_dir}")
    print("\n地形代码:")
    print("  0 = 空（不可行走）")
    print("  1 = 地面（可行走）")
    print("  2 = 高台（远程位）")
    print("  3 = 障碍（不可行走）")

if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""sannomiya_timetable.json から norinavi/realtime.js を生成する。"""
import json
import io

with open('sannomiya_timetable.json', encoding='utf-8') as f:
    data = json.load(f)

DIR_LABEL = {'up': '上り(尼崎・大阪・北新地・京都方面)', 'down': '下り(西明石・姫路方面)'}
DAY_LABEL = {'weekday': '平日', 'holiday': '休日'}


def fmt_entries(entries):
    # 0時台(深夜)は前日からの継続として24:00以降(1440+)に正規化してから時刻順に並べ直す
    norm = [e['min'] + 1440 if e['h'] == 0 else e['min'] for e in entries]
    pairs = sorted(zip(norm, entries), key=lambda p: p[0])
    lines = []
    for m, e in pairs:
        lines.append("      {min:%d, type:'%s', dest:'%s'}," % (m, e['type'], e['dest']))
    return '\n'.join(lines)


out = io.open('../realtime.js', 'w', encoding='utf-8', newline='\n')
out.write("'use strict';\n\n")
out.write("// 三ノ宮駅 JR神戸線(o_jrkk)の実時刻表データ\n")
out.write("// 出典: JRおでかけネット公式時刻表 (https://timetable.jr-odekake.net/cgi-bin/mydia_sp.cgi?MD=3&FN=0&EID=0610143&EN=%91%E5%8D%E3)\n")
out.write("// min = 0:00からの分数, type = 列車種別(普通/快速/新快速/特急), dest = 行先\n")
out.write("const REAL_TIMETABLES = {\n")
out.write("  '三宮': {\n")
out.write("    o_jrkk: {\n")
for direction in ['up', 'down']:
    out.write("      %s: { // %s\n" % (direction, DIR_LABEL[direction]))
    for daytype in ['weekday', 'holiday']:
        out.write("        %s: [ // %s\n" % (daytype, DAY_LABEL[daytype]))
        out.write(fmt_entries(data[direction][daytype]))
        out.write("\n        ],\n")
    out.write("      },\n")
out.write("    }\n")
out.write("  }\n")
out.write("};\n")
out.close()
print('done')

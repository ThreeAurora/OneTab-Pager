// build-replica.mjs — 生成雪碧图数据 + 把复刻模块拼接进 onetab.virtual.js
import fs from 'node:fs';

const SRC = 'E:/CCSpace/projects/2026/09/OneTab性能诊断/OneTab-patched-unpacked/ext-onetab-concatenated-sources-onetab.js';
const SECTION = 'E:/CCSpace/cache/tmp/onetab-lab/replica-section.js';
const TARGET = 'E:/CCSpace/projects/2026/09/OneTab性能诊断/OneTab-Pager/onetab.virtual.js';
const REPORT = 'E:/CCSpace/cache/tmp/onetab-lab/results/build-replica.json';

const src = fs.readFileSync(SRC, 'utf8');
const start = src.indexOf('zt.jo=new Map');
if (start < 0) throw new Error('雪碧图映射块未找到');
// 从块起点向后取窗口，按「位置连续」收集 t.set("domain",idx) 对（块外代码介入即停）
const win = src.slice(start, start + 80000);
const re = /t\.set\("([^"]+)",(\d+)\)/g;
const pairs = [];
let prevEnd = -1, m;
while ((m = re.exec(win)) !== null) {
  if (prevEnd >= 0 && m.index - prevEnd > 80) break;   // 与上一条相距过远 = 已出块
  const idx = +m[2];
  if (idx < 0 || idx > 2000) break;
  pairs.push({ d: m[1], i: idx });
  prevEnd = m.index + m[0].length;
}
if (pairs.length < 500) throw new Error('雪碧图对数异常: ' + pairs.length);
// 去重（同域名取首个），校验 bilibili.com=167 与实测一致
const seen = new Set(), out = [];
for (const p of pairs) {
  if (seen.has(p.d)) continue;
  seen.add(p.d);
  out.push(p.d + ':' + p.i);
}
const data = out.join(',');
const check = {
  rawPairs: pairs.length,
  unique: out.length,
  bilibili: pairs.find((p) => p.d === 'bilibili.com') || null,
  maxIdx: Math.max(...pairs.map((p) => p.i)),
  dataKB: Math.round(data.length / 1024),
};

const section = fs.readFileSync(SECTION, 'utf8').replace("'__SPRITE_DATA__'", JSON.stringify(data));
const target = fs.readFileSync(TARGET, 'utf8');
if (target.includes('function rpBuildShell')) throw new Error('目标文件已含复刻模块，拒绝重复拼接');
const anchor = '  function boot() {';
const at = target.indexOf(anchor);
if (at < 0) throw new Error('boot 锚点未找到');
const next = target.slice(0, at) + section.replace(/^\n/, '') + '\n' + target.slice(at);
fs.writeFileSync(TARGET, next);
check.spliced = true;
check.targetSize = next.length;
fs.writeFileSync(REPORT, JSON.stringify(check, null, 1));
console.log(JSON.stringify(check));

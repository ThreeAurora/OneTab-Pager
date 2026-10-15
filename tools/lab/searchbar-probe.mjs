// searchbar-probe.mjs — 搜索框可见性探针
// 目的：确认补丁复刻期对 #contentAreaDiv 子元素做的 opacity/content-visibility 干预，
//       在换装（摘壳）之后有没有被完整恢复。
//
// 采样内容（每 500ms，仅变化时输出）：
//   · #contentAreaDiv 每个子元素：内联 opacity/content-visibility + computed + rect
//   · 页面内每个 <input>（官方搜索框）：祖先链上是否有 opacity:0 / content-visibility:hidden
//     残留、rect 是否为零、elementFromPoint 命中谁
//
// 用法：node tools/lab/searchbar-probe.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, listTargets } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const extDir = path.resolve(process.argv[2] || path.join(PROJECT, 'OneTab-patched-unpacked'));
const port = 9336;

const unpacked = readUnpackedExtensions(realUserDataDir());
const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === extDir.toLowerCase());
if (!match) throw new Error('未在 Edge 中找到该解压扩展: ' + extDir);

const profileDir = labTmpDir('profile-searchbar');
const { copied } = prepareProfile({ extId: match.id, profileDir });
console.log('数据带入:', copied.join(', ') || '(空)');

const SAMPLE = `(() => {
  function short(el) {
    return el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '');
  }
  function hitTest(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 'zero-rect';
    const els = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return els.slice(0, 3).map(short).join('<');
  }
  const cad = document.getElementById('contentAreaDiv');
  const kids = cad ? Array.from(cad.children).map(k => {
    const cs = getComputedStyle(k); const r = k.getBoundingClientRect();
    return short(k)
      + ' inline[cv=' + (k.style.contentVisibility || '-') + ' op=' + (k.style.opacity || '-') + ']'
      + ' computed[cv=' + cs.contentVisibility + ' op=' + cs.opacity + ']'
      + ' rect=' + [r.x|0, r.y|0, r.width|0, r.height|0].join(',');
  }) : [];
  const inputs = Array.from(document.querySelectorAll('input')).map(i => {
    const r = i.getBoundingClientRect();
    let cv = '-', op = '-', vis = '-';
    let el = i;
    while (el && el !== document.documentElement) {
      const c = getComputedStyle(el);
      if (c.contentVisibility === 'hidden') cv = short(el);
      if (c.opacity === '0') op = short(el);
      if (c.visibility === 'hidden') vis = short(el);
      el = el.parentElement;
    }
    return { ph: i.placeholder || i.type, rect: [r.x|0, r.y|0, r.width|0, r.height|0].join(','),
      hiddenBy: [cv !== '-' ? 'cv:' + cv : '', op !== '-' ? 'op:' + op : '', vis !== '-' ? 'vis:' + vis : ''].filter(Boolean).join(' ') || 'none',
      hit: hitTest(i) };
  });
  const rp = window.__otvz && window.__otvz.replica ? window.__otvz.replica : null;
  return JSON.stringify({ t: Math.round(performance.now()), replica: rp, kids, inputs });
})()`;

const edge = await launchEdge({ profileDir, extDir, port });
let cdp;
try {
  ({ cdp } = await connectBrowser(edge.base));
  const { id: extId } = await findExtensionId(cdp, match.id);
  console.log('扩展 ID:', extId);

  const pageUrl = `chrome-extension://${extId}/onetab.html`;
  const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);

  const snapshots = [];
  let lastKey = '';
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const r = await cdp.send('Runtime.evaluate', { expression: SAMPLE, returnByValue: true }, sessionId)
      .catch(() => null);
    if (!r || !r.result || r.result.value == null) continue;
    const s = JSON.parse(r.result.value);
    snapshots.push(s);
    const key = JSON.stringify([s.kids, s.inputs]);
    if (key !== lastKey) {
      lastKey = key;
      console.log('\n--- t=' + s.t + 'ms  replica=' + JSON.stringify(s.replica));
      for (const k of s.kids) console.log('    kid  ' + k);
      for (const inp of s.inputs) console.log('    input ph="' + inp.ph + '" rect=' + inp.rect + ' hiddenBy=' + inp.hiddenBy + ' hit=' + inp.hit);
    }
    if (i > 4 && s.replica && s.replica.swapped) {
      await sleep(2500);   // 换装后再多观察 3 轮
      for (let j = 0; j < 6; j++) {
        await sleep(500);
        const r2 = await cdp.send('Runtime.evaluate', { expression: SAMPLE, returnByValue: true }, sessionId).catch(() => null);
        if (r2 && r2.result && r2.result.value) snapshots.push(JSON.parse(r2.result.value));
      }
      break;
    }
  }

  const out = path.join(labTmpDir('results'), 'searchbar-probe.json');
  fs.writeFileSync(out, JSON.stringify({ extDir, snapshots }, null, 2));
  console.log('\n结果已写入', out);
  const lastSnap = snapshots[snapshots.length - 1];
  console.log('最后一帧 kids/inputs：');
  console.log(JSON.stringify({ kids: lastSnap?.kids, inputs: lastSnap?.inputs, replica: lastSnap?.replica }, null, 2));
} finally {
  await sleep(300);
  edge.kill();
}

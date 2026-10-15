// hold-probe.mjs — 判定「复刻期按住官方全量渲染」在当前实现里是否真的生效，并量化它的收益。
//
// 背景：v3.2 的设计意图是复刻期给官方列表容器加 content-visibility:hidden，
//       把几千行的布局开销按到换装为止。但补丁每轮 rpTick 是「先 hide 全部、
//       再（复刻页就绪后）unhide」——若两侧作用于同一批元素，按住就被抵消。
//       本探针直接看事实，不猜。
//
// 两种模式：
//   A（默认）          只观察：每 150ms 采样非壳子元素的 content-visibility + 长任务
//   B（--force-hold）  注入 !important 样式表强制按住非壳子元素（补丁清不掉），
//                      3.0s 时移除，对比长任务分布 —— 回答「按住到底值多少」
//
// 用法：
//   node tools/lab/hold-probe.mjs
//   node tools/lab/hold-probe.mjs --force-hold

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, listTargets } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const EXT = path.join(PROJECT, 'OneTab-patched-unpacked');
const FORCE = process.argv.includes('--force-hold');
const PORT = parseInt(process.env.HP_PORT || (FORCE ? '9452' : '9451'), 10);
const SAMPLE_MS = parseInt(process.env.HP_SAMPLE || '9000', 10);
const HOLD_UNTIL_MS = parseInt(process.env.HP_HOLD_UNTIL || '5000', 10);
const OUT = process.env.HP_OUT
  || path.join('E:', path.sep, 'CCSpace', 'cache', 'tmp', 'onetab-lab', 'results', 'hold-probe' + (FORCE ? '-force' : '') + '.json');

const SNAP = `(() => {
  const cad = document.getElementById('contentAreaDiv');
  if (!cad) return null;
  const kids = [...cad.children].filter(function (k) { return !k.getAttribute('data-otvz-replica'); });
  return {
    t: Math.round(performance.now()),
    swapped: !!(window.__otvz && window.__otvz.replica && window.__otvz.replica.swapped),
    repRows: window.__otvz && window.__otvz.replica ? window.__otvz.replica.rows : 0,
    offTabs: document.querySelectorAll('.tab').length,
    cvInline: kids.map(function (k) { return k.style.contentVisibility || '(none)'; }),
    cvComputed: kids.map(function (k) { return getComputedStyle(k).contentVisibility; }),
    heldNow: kids.filter(function (k) { return getComputedStyle(k).contentVisibility === 'hidden'; }).length,
    lt: window.__cloneLT ? window.__cloneLT.length : 0,
    ltTotal: window.__cloneLT ? Math.round(window.__cloneLT.reduce(function (a, b) { return a + b; }, 0)) : 0,
    ltMax: window.__cloneLT ? Math.round(Math.max(0, ...window.__cloneLT)) : 0
  };
})()`;

const HOLD_CSS = '#contentAreaDiv > div:not([data-otvz-replica]){content-visibility:hidden !important;}';
// 注意：addScriptToEvaluateOnNewDocument 执行时 document.documentElement 可能还是 null，
// 用 MutationObserver 直接 observe 会抛 TypeError 导致整段失效（踩过）→ 用 30ms 轮询等 head。
const HOLD_BOOT = `(function(){var n=0;var t=setInterval(function(){n++;if(n>600){clearInterval(t);return;}
  if(!document.head||document.getElementById('otvz-hold')){if(n>600||document.getElementById('otvz-hold'))clearInterval(t);return;}
  var s=document.createElement('style');s.id='otvz-hold';s.textContent=${JSON.stringify(HOLD_CSS)};document.head.appendChild(s);clearInterval(t);},30);})();`;

async function main() {
  const report = { mode: FORCE ? 'force-hold' : 'observe', when: new Date().toISOString() };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('扩展未加载: ' + EXT);

  const profileDir = labTmpDir('profile-hold-' + PORT);
  prepareProfile({ extId: match.id, profileDir });
  const edge = await launchEdge({ profileDir, extDir: EXT, port: PORT, headless: true });

  let cdp = null, sessionId = null;
  try {
    ({ cdp } = await connectBrowser(edge.base));
    const { id } = await findExtensionId(cdp, match.id);
    const pageUrl = `chrome-extension://${id}/onetab.html`;

    const pageTarget = await waitFor(async () => {
      const ts = await listTargets(cdp);
      return ts.find((t) => t.type === 'page' && t.url === 'about:blank') || null;
    }, { timeout: 25000, interval: 200, label: '新标签页' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true }));

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pageTarget.targetId }, sessionId);
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1400, height: 950 } });
    } catch { /* 忽略 */ }
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__cloneLT=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__cloneLT.push(e.duration);});}).observe({entryTypes:['longtask']});}catch(e){}
${FORCE ? HOLD_BOOT : ''}`,
    }, sessionId);

    const t0 = Date.now();
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await sleep(200);

    if (FORCE) {
      setTimeout(() => {
        cdp.send('Runtime.evaluate', {
          expression: `(function(){var s=document.getElementById('otvz-hold');
            var info = s ? {rules: (s.sheet && s.sheet.cssRules) ? s.sheet.cssRules.length : -1} : null;
            if(s){s.remove();}
            return JSON.stringify({found: !!s, info: info});})()`,
          returnByValue: true,
        }, sessionId).then((r) => { report.holdStyleAtRemoval = r && r.result ? r.result.value : null; }).catch(() => {});
      }, HOLD_UNTIL_MS);
    }

    const timeline = [];
    while (Date.now() - t0 < SAMPLE_MS) {
      const r = await cdp.send('Runtime.evaluate', { expression: SNAP, returnByValue: true }, sessionId).catch(() => null);
      if (r && r.result && r.result.value) timeline.push({ wall: Date.now() - t0, ...r.result.value });
      await sleep(150);
    }
    await sleep(2500);
    const steady = await cdp.send('Runtime.evaluate', { expression: SNAP, returnByValue: true }, sessionId).catch(() => null);
    report.timeline = timeline;
    report.steady = steady && steady.result ? steady.result.value : null;
    report.ok = true;
  } catch (e) {
    report.fatal = e.message;
  } finally {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await sleep(200);
    edge.kill();
  }

  if (!report.ok) { console.error(report.fatal); process.exitCode = 1; return; }
  console.log('mode=' + report.mode);
  console.log('   t(ms) swapped heldNow cvInline                 offTabs ltN ltTotal ltMax');
  for (const s of report.timeline) {
    if (s.t % 450 > 160) continue;   // 抽稀打印
    console.log('  ' + String(s.wall).padStart(5) + ' ' + String(s.swapped).padEnd(7) + ' '
      + String(s.heldNow).padStart(2) + '      ' + JSON.stringify(s.cvInline).slice(0, 40).padEnd(42) + ' '
      + String(s.offTabs).padStart(5) + ' ' + String(s.lt).padStart(3) + ' ' + String(s.ltTotal).padStart(6) + ' ' + String(s.ltMax).padStart(5));
  }
  console.log('稳态:', JSON.stringify(report.steady));
  console.log('结果已写入', OUT);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

// navwidth-probe.mjs — 在稳态下量出官方侧栏的盒子模型（宽/边框/内边距/滚动条），
// 用于给复刻壳预留正确宽度。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, listTargets } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const EXT = path.join(PROJECT, 'OneTab-patched-unpacked');
const PORT = parseInt(process.env.NW_PORT || '9781', 10);
const OUT = process.env.NW_OUT || 'E:/CCSpace/cache/tmp/onetab-lab/results/navwidth-probe.json';
const LABEL = process.env.NW_LABEL || 'navwidth-probe';

const SNAP = `(() => {
  const cad = document.getElementById('contentAreaDiv');
  if (!cad) return { noCad: true };
  const kids = [...cad.children];
  // 找三栏容器：flex 且高度大
  let main = kids.find(k => getComputedStyle(k).display === 'flex' && k.getBoundingClientRect().height > 300);
  if (!main) main = kids[kids.length - 1];
  const cols = main ? [...main.children].map(el => {
    const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return {
      cls: (el.className||'').toString().slice(0,50),
      rect: { x: +b.x.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) },
      box: { bw: cs.borderLeftWidth+'/'+cs.borderRightWidth, pad: cs.paddingLeft+'/'+cs.paddingRight,
             ml: cs.marginLeft, mr: cs.marginRight, flex: cs.flex, minW: cs.minWidth, maxW: cs.maxWidth,
             ovf: cs.overflow, ovfY: cs.overflowY, boxSizing: cs.boxSizing },
      scrollbar: el.offsetWidth - el.clientWidth,
      text: (el.innerText||'').replace(/\\n+/g,' | ').slice(0,70)
    };
  }) : null;
  return {
    cadKids: kids.map(k => { const b = k.getBoundingClientRect(); return { tag: k.tagName, disp: getComputedStyle(k).display, y: Math.round(b.y), h: Math.round(b.height), w: Math.round(b.width) }; }),
    mainRect: main ? (() => { const b = main.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) }; })() : null,
    mainStyle: main ? (() => { const cs = getComputedStyle(main); return { disp: cs.display, flexDirection: cs.flexDirection, pad: cs.padding, gap: cs.gap, bg: cs.backgroundColor }; })() : null,
    cols
  };
})()`;

async function main() {
  const report = { label: LABEL, when: new Date().toISOString() };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  report.extId = match.id;
  const profileDir = labTmpDir('profile-' + LABEL);
  prepareProfile({ extId: match.id, profileDir });
  const edge = await launchEdge({ profileDir, extDir: EXT, port: PORT, headless: true });
  let cdp = null, sessionId = null;
  try {
    ({ cdp } = await connectBrowser(edge.base));
    const { id } = await findExtensionId(cdp, match.id);
    const pt = await waitFor(async () => {
      const ts = await listTargets(cdp);
      return ts.find((t) => t.type === 'page' && t.url === 'about:blank') || null;
    }, { timeout: 25000, interval: 200, label: '新标签页' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: pt.targetId, flatten: true }));
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pt.targetId }, sessionId);
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1400, height: 950 } });
    } catch (_) {}
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
    await cdp.send('Page.navigate', { url: `chrome-extension://${id}/onetab.html` }, sessionId).catch(() => {});
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});

    // 等到稳态（tabs>=5000 且 replica 已退出）
    await waitFor(async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: 'document.querySelectorAll(".tab").length >= 5000 && !document.querySelector("[data-otvz-replica]")', returnByValue: true }, sessionId);
      return r.result.value === true;
    }, { timeout: 40000, interval: 300, label: '稳态' }).catch(() => {});
    await sleep(600);

    const r = await cdp.send('Runtime.evaluate', { expression: SNAP, returnByValue: true }, sessionId);
    report.snap = r.result.value;

    // 再量一次：临时把窗口拉宽，看侧栏是否跟着变（判断是固定还是百分比）
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pt.targetId }, sessionId);
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1800, height: 950 } });
      await sleep(700);
      const r2 = await cdp.send('Runtime.evaluate', { expression: SNAP, returnByValue: true }, sessionId);
      report.snapWide = r2.result.value;
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 1400, height: 950 } });
      await sleep(500);
    } catch (_) {}
    report.ok = true;
  } catch (e) {
    report.fatal = e.message;
  } finally {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    try { if (cdp) cdp.close(); } catch (_) {}
    await sleep(200);
    edge.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

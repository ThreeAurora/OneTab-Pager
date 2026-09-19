// navcol-probe.mjs — 精确追踪官方三栏（navCol / centerCol / quickAccessCol）的出现时机，
// 以及它们在复刻期是否被补丁的 opacity:0 藏住。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, listTargets } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const EXT = path.join(PROJECT, 'OneTab-patched-unpacked');
const PORT = parseInt(process.env.NV_PORT || '9755', 10);
const OUT = process.env.NV_OUT || 'E:/CCSpace/cache/tmp/onetab-lab/results/navcol-probe.json';
const LABEL = process.env.NV_LABEL || 'navcol-probe';
const SAMPLE_MS = parseInt(process.env.NV_SAMPLE || '9000', 10);

const SNAP = `(() => {
  const v = window.__otvz;
  const cad = document.getElementById('contentAreaDiv');
  // contentAreaDiv 的完整子树（2 层），带几何与可见性
  const walk = (el, depth) => {
    if (!el || depth > 2) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName, id: el.id, cls: (el.className||'').toString().slice(0,60),
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      inline: { op: el.style.opacity, pe: el.style.pointerEvents },
      cs: { op: cs.opacity, disp: cs.display, vis: cs.visibility },
      rep: el.getAttribute && el.getAttribute('data-otvz-replica'),
      kids: depth < 2 ? [...el.children].slice(0,8).map(k => walk(k, depth+1)) : []
    };
  };
  // 专门找 navCol 特征：class 含 column 或 navCol
  const columns = [...document.querySelectorAll('[class*="column"], [class*="Column"], [class*="navCol"], [class*="NavCol"]')].map(el => {
    const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    const ib = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
    return { cls: (el.className||'').toString().slice(0,70), id: el.id,
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      cs: { op: cs.opacity, disp: cs.display, vis: cs.visibility, overflow: cs.overflow },
      parentOp: el.parentElement ? el.parentElement.style.opacity : null,
      text: (el.innerText||'').replace(/\\n+/g,' | ').slice(0,100) };
  });
  return {
    t: performance.now(),
    tabs: document.querySelectorAll('.tab').length,
    replicaInDom: !!document.querySelector('[data-otvz-replica]'),
    cadKidCount: cad ? cad.children.length : 0,
    cad: cad ? [...cad.children].map(k => walk(k, 0)) : null,
    columns,
    state: v ? v.pageState : null
  };
})()`;

async function main() {
  const report = { label: LABEL, when: new Date().toISOString() };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('未找到扩展');
  report.extId = match.id;
  const profileDir = labTmpDir('profile-' + LABEL);
  prepareProfile({ extId: match.id, profileDir });
  const edge = await launchEdge({ profileDir, extDir: EXT, port: PORT, headless: true });
  report.pid = edge.pid;

  let cdp = null, sessionId = null;
  try {
    ({ cdp } = await connectBrowser(edge.base));
    const { id } = await findExtensionId(cdp, match.id);
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
    } catch (_) {}
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});

    const evalSnap = async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: SNAP, returnByValue: true }, sessionId);
      return r.result && r.result.value;
    };

    const t0 = Date.now();
    await cdp.send('Page.navigate', { url: `chrome-extension://${id}/onetab.html` }, sessionId).catch(() => {});
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});

    const timeline = [];
    const deadline = t0 + SAMPLE_MS;
    while (Date.now() < deadline) {
      try { const s = await evalSnap(); if (s) timeline.push({ t: Date.now() - t0, ...s }); } catch (e) { timeline.push({ t: Date.now() - t0, err: e.message }); }
      await sleep(150);
    }
    report.timeline = timeline;
    report.samples = timeline.length;
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

// sidebar-probe.mjs — 探查左侧边栏的 DOM 结构/出现时机，以及先遣期两条翻页条的排布
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, listTargets } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const EXT = path.join(PROJECT, 'OneTab-patched-unpacked');
const PORT = parseInt(process.env.SP_PORT || '9711', 10);
const OUT = process.env.SP_OUT || 'E:/CCSpace/cache/tmp/onetab-lab/results/sidebar-probe.json';
const LABEL = process.env.SP_LABEL || 'sidebar-probe';
const SAMPLE_MS = parseInt(process.env.SP_SAMPLE || '9000', 10);

const SNAP = `(() => {
  const v = window.__otvz;
  const cad = document.getElementById('contentAreaDiv');
  const cadKids = cad ? [...cad.children].map((k, i) => {
    const b = k.getBoundingClientRect();
    return { i, tag: k.tagName, cls: (k.className||'').toString().slice(0,70), rep: k.getAttribute && k.getAttribute('data-otvz-replica'),
      op: k.style.opacity, pe: k.style.pointerEvents,
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      kids: k.children.length };
  }) : null;
  const sidebarCand = [...document.querySelectorAll('div,nav,aside,section')].filter(el => {
    try { const b = el.getBoundingClientRect();
      return b.width > 60 && b.width < 430 && b.height > 250 && b.x < 80 && b.y < 260; } catch(e){ return false; }
  }).slice(0, 8).map(el => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { tag: el.tagName, id: el.id, cls: (el.className||'').toString().slice(0,80),
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      text: (el.innerText||'').replace(/\\n+/g,' | ').slice(0,140),
      childCount: el.children.length, op: cs.opacity, disp: cs.display, vis: cs.visibility };
  });
  const pagers = [...document.querySelectorAll('.otvz-pager')].map(el => {
    const b = el.getBoundingClientRect();
    const p = el.parentElement;
    return { cls: el.className, disp: getComputedStyle(el).display, connected: el.isConnected,
      rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      parent: p ? (p.getAttribute('data-otvz-replica-barhost')!==null ? 'barHost' : (p.id || p.tagName)) : null };
  });
  const bh = document.querySelector('[data-otvz-replica-barhost]');
  const barHostRect = bh ? (() => { const b = bh.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; })() : null;
  const sp = document.getElementById('loadingSpinner');
  return {
    tabs: document.querySelectorAll('.tab').length,
    groups: document.querySelectorAll('.tabGroup').length,
    bodyKids: document.body ? document.body.children.length : 0,
    replicaInDom: !!document.querySelector('[data-otvz-replica]'),
    spinner: sp ? { disp: getComputedStyle(sp).display, y: Math.round(sp.getBoundingClientRect().y) } : null,
    cadKids, sidebarCand, pagers, barHostRect,
    pagerCount: pagers.length,
    pagerConnected: pagers.filter(x => x.connected).length,
    navColReserve: (() => { const n = document.querySelector('[data-otvz-replica-navcol]'); if (!n) return null;
      const b = n.getBoundingClientRect(); return { w: Math.round(b.width), x: Math.round(b.x), bg: getComputedStyle(n).backgroundColor }; })(),
    listStartX: (() => { const l = document.querySelector('[data-otvz-replica-list]'); if (!l) return null;
      return Math.round(l.getBoundingClientRect().x); })(),
    officialColX: (() => { const cad = document.getElementById('contentAreaDiv'); if (!cad) return null;
      const main = [...cad.children].find(k => getComputedStyle(k).display === 'flex' && k.getBoundingClientRect().height > 300);
      if (!main) return null; const c = main.children[1]; return c ? Math.round(c.getBoundingClientRect().x) : null; })(),
    state: v ? v.pageState : null,
    replica: v ? v.replica : null
  };
})()`;

async function main() {
  const report = { label: LABEL, when: new Date().toISOString() };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('该目录不是已加载的解压扩展:\n' + unpacked.map((u) => '  ' + u.path).join('\n'));
  report.extId = match.id;

  const profileDir = labTmpDir('profile-' + LABEL);
  prepareProfile({ extId: match.id, profileDir });

  let died = null;
  const edge = await launchEdge({ profileDir, extDir: EXT, port: PORT, headless: true, onExit: (e) => { died = e; } });
  report.pid = edge.pid;

  let cdp = null, sessionId = null, targetId = null;
  try {
    ({ cdp } = await connectBrowser(edge.base));
    const { id } = await findExtensionId(cdp, match.id);
    report.resolvedId = id;

    // 开一个空白页再导航到扩展页（与 refresh-probe 一致，避免复用自动打开的页）
    const pageTarget = await waitFor(async () => {
      const ts = await listTargets(cdp);
      return ts.find((t) => t.type === 'page' && t.url === 'about:blank') || null;
    }, { timeout: 25000, interval: 200, label: '新标签页' });
    targetId = pageTarget.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId }, sessionId);
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1400, height: 950 } });
    } catch (_) {}
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});

    const evalSnap = async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: SNAP, returnByValue: true, awaitPromise: false }, sessionId);
      return r.result && r.result.value;
    };

    // 导航到扩展页，抓加载最开始的瞬间
    const pageUrl = `chrome-extension://${id}/onetab.html`;
    const reloadAt = Date.now();
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId).catch(() => {});
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});

    const timeline = [];
    const deadline = reloadAt + SAMPLE_MS;
    while (Date.now() < deadline) {
      try {
        const s = await evalSnap();
        if (s) timeline.push({ t: Date.now() - reloadAt, ...s });
      } catch (e) { timeline.push({ t: Date.now() - reloadAt, err: e.message }); }
      await sleep(120);
    }
    report.timeline = timeline;
    report.samples = timeline.length;
    report.ok = true;
  } catch (e) {
    report.fatal = e.message;
    try { report.diagTargets = (await listTargets(cdp)).map((t) => t.url); } catch (_) {}
  } finally {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    try { if (cdp) cdp.close(); } catch (_) {}
    await sleep(200);
    edge.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

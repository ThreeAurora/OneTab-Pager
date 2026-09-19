// idb-probe.mjs — 探测 OneTab 的 IndexedDB 数据结构 + 抓官方行 DOM 模板
// 为「首屏直出」（boot 直接读 IDB 复刻第一页）收集设计数据。
// 输出：databases / stores / 记录样例 / 显示顺序映射 / tabGroup·tab 外层 HTML 模板
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, listTargets, closeTarget } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const EXT = path.join(PROJECT, 'OneTab-patched-unpacked');
const OUT = process.env.ONETAB_IDB_OUT
  || path.join('E:', path.sep, 'CCSpace', 'cache', 'tmp', 'onetab-lab', 'results', 'idb-probe.json');
const PORT = parseInt(process.env.ONETAB_IDB_PORT || '9381', 10);
const HEADLESS = !process.argv.includes('--windowed');

const EXPLORE = `(async () => {
  const safe = (v, depth) => {
    if (depth > 4) return '…';
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'string') return v.length > 120 ? v.slice(0, 120) + '…(' + v.length + ')' : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'function') return '[fn]';
    if (Array.isArray(v)) return v.slice(0, 6).map((x) => safe(x, depth + 1));
    if (v instanceof Date) return v.toISOString();
    const o = {};
    for (const k of Object.keys(v).slice(0, 24)) o[k] = safe(v[k], depth + 1);
    return o;
  };
  const out = { dbs: [], ls: {}, ss: {} };
  const dbs = await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]));
  for (const dbInfo of dbs) {
    const entry = { name: dbInfo.name, version: dbInfo.version, stores: [] };
    await new Promise((res, rej) => {
      const req = indexedDB.open(dbInfo.name, dbInfo.version);
      req.onupgradeneeded = () => { req.transaction.abort(); };
      req.onsuccess = () => {
        const db = req.result;
        try {
          for (const sn of db.objectStoreNames) {
            const st = {};
            const tx = db.transaction(sn, 'readonly');
            const store = tx.objectStore(sn);
            st.name = sn;
            st.keyPath = store.keyPath;
            st.autoIncrement = store.autoIncrement;
            st.indexNames = Array.from(store.indexNames);
            const cReq = store.count();
            cReq.onsuccess = () => { st.count = cReq.result; };
            const aReq = store.getAll(null, 5);
            aReq.onsuccess = () => { st.first5 = aReq.result.map((r) => safe(r, 0)); };
            tx.oncomplete = () => entry.stores.push(st);
            tx.onerror = () => entry.stores.push({ name: sn, err: String(tx.error) });
          }
        } finally { setTimeout(res, 50); }
      };
      req.onerror = () => res();
      setTimeout(res, 5000);
    });
    out.dbs.push(entry);
  }
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.ls[k] = String(localStorage.getItem(k)).slice(0, 200); } } catch (e) {}
  try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.ss[k] = String(sessionStorage.getItem(k)).slice(0, 200); } } catch (e) {}
  return out;
})()`;

const TEMPLATE = `(() => {
  const g = document.querySelector('#centerColItems > .tabGroup') || document.querySelector('.tabGroup');
  const t = document.querySelector('.tab');
  const cci = document.getElementById('centerColItems');
  const chain = [];
  let n = cci;
  while (n && n !== document.body) { chain.push({ tag: n.tagName, id: n.id || null, cls: n.className || null, kids: n.children.length }); n = n.parentElement; }
  return {
    centerColItems: !!cci,
    centerKids: cci ? cci.children.length : 0,
    parentChain: chain,
    groupHTML: g ? g.outerHTML.slice(0, 6000) : null,
    tabHTML: t ? t.outerHTML.slice(0, 2000) : null,
    groupCount: document.querySelectorAll('.tabGroup').length,
  };
})()`;

const ORDER = `(() => {
  const g = document.querySelector('#centerColItems > .tabGroup');
  if (!g) return null;
  const firstTab = g.querySelector('.tab a');
  return {
    firstGroupText: (g.textContent || '').trim().slice(0, 120),
    firstTabHref: firstTab ? firstTab.href : null,
    firstTabText: firstTab ? firstTab.textContent.trim().slice(0, 80) : null,
  };
})()`;

async function main() {
  const report = { when: new Date().toISOString(), headless: HEADLESS };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('扩展未加载: ' + EXT);
  report.extId = match.id;

  const profileDir = labTmpDir('profile-idb-probe');
  prepareProfile({ extId: match.id, profileDir });

  const edge = await launchEdge({ profileDir, extDir: EXT, port: PORT, headless: HEADLESS, onExit: () => {} });

  let cdp = null, sessionId = null, targetId = null;
  try {
    ({ cdp } = await connectBrowser(edge.base));
    const { id } = await findExtensionId(cdp, match.id);
    const pageUrl = `chrome-extension://${id}/onetab.html`;

    const swTarget = (await listTargets(cdp)).find((t) => t.type === 'service_worker' && new URL(t.url).host === id);
    const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, swSession);
    const swEval = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSession);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    };
    await waitFor(() => swEval('typeof chrome!=="undefined" && !!chrome.tabs').catch(() => false), { timeout: 20000, interval: 300, label: 'SW 就绪' });

    await swEval('chrome.tabs.create({url:"about:blank", active:true})');
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
    } catch { /* 忽略 */ }
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});

    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) return { evalErr: (r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
      return r.result?.value;
    };

    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await new Promise((resolve) => {
      const to = setTimeout(resolve, 60000);
      cdp.on('Page.loadEventFired', (p, sid) => { if (sid === sessionId) { clearTimeout(to); resolve(); } });
    });
    // 等列表渲染完，保证 DOM 模板与顺序映射可用
    try {
      await waitFor(async () => {
        const s = await evalJs('document.querySelectorAll(".tab").length');
        return typeof s === 'number' && s >= 4000;
      }, { timeout: 45000, interval: 500, label: '列表渲染出现' });
    } catch (e) {
      // headless 偶发不渲染：reload + 重新激活再试一轮
      report.firstTryStuck = await evalJs(`({ tabs: document.querySelectorAll('.tab').length, spinner: !!document.getElementById('loadingSpinner'), ready: document.readyState, kids: (document.getElementById('contentAreaDiv')||{children:[]}).children.length })`);
      await cdp.send('Page.reload', {}, sessionId);
      await new Promise((resolve) => {
        const to = setTimeout(resolve, 60000);
        cdp.on('Page.loadEventFired', (p, sid) => { if (sid === sessionId) { clearTimeout(to); resolve(); } });
      });
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
      await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
      await waitFor(async () => {
        const s = await evalJs('document.querySelectorAll(".tab").length');
        return typeof s === 'number' && s >= 4000;
      }, { timeout: 45000, interval: 500, label: '列表渲染出现(reload后)' });
    }
    await sleep(1500);

    report.idb = await evalJs(EXPLORE);
    report.template = await evalJs(TEMPLATE);
    report.displayOrder = await evalJs(ORDER);
    report.otvzBoot = await evalJs('window.__otvz ? { stats: window.__otvz.stats, page: window.__otvz.pageState } : null');
  } catch (e) {
    report.fatal = e.message;
  } finally {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    try { if (cdp && targetId) await closeTarget(cdp, targetId); } catch { /* 忽略 */ }
    await sleep(200);
    edge.kill();
  }
}

main().catch(() => process.exitCode = 1);

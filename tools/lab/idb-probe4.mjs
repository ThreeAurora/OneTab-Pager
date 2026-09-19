// idb-probe4.mjs — 复刻读取链路现场诊断：在页面里逐步重放 rpLoad 的每个环节
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
  || path.join('E:', path.sep, 'CCSpace', 'cache', 'tmp', 'onetab-lab', 'results', 'idb-probe4.json');
const PORT = parseInt(process.env.ONETAB_IDB_PORT || '9399', 10);
const HEADLESS = !process.argv.includes('--windowed');

// 逐环节重放（与 onetab.virtual.js 的 rpLoad 完全同构），每步都记录
const TRACE = `(async () => {
  const log = [];
  const step = (name, v) => log.push({ name, v });
  let db = null;
  try {
    db = await new Promise((res, rej) => {
      const r = indexedDB.open('onetab', 2);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || 'open error');
      r.onblocked = () => rej('blocked');
      setTimeout(() => rej('open timeout'), 5000);
    });
    step('open', { name: db.name, version: db.version, stores: Array.from(db.objectStoreNames) });
  } catch (e) { step('open.fail', String(e)); return { log }; }
  let store = null;
  try {
    const tx = db.transaction('item', 'readonly');
    store = tx.objectStore('item');
    step('hasStore', { storeName: store.name, keyPath: store.keyPath });
    const g = (k) => new Promise((res) => {
      let done = false;
      const r = store.get(k);
      r.onsuccess = () => { if (!done) { done = true; res(r.result ?? null); } };
      r.onerror = () => { if (!done) { done = true; res('GETERR:' + (r.error && r.error.name)); } };
      setTimeout(() => { if (!done) { done = true; res('GETTIMEOUT'); } }, 3000);
    });
    const root = await g('root');
    step('get(root)', root ? { id: root.id, type: root.type, groupType: root.groupType, childCount: (root.childIds || []).length, head: (root.childIds || []).slice(0, 3), keys: Object.keys(root) } : root);
    if (root && root.childIds && root.childIds.length) {
      const g1 = await g(root.childIds[0]);
      step('get(child0)', g1 ? { id: g1.id, type: g1.type, groupType: g1.groupType, childCount: (g1.childIds || []).length, keys: Object.keys(g1), title: g1.title || null, createDate: g1.createDate || null } : g1);
      if (g1) {
        const t1 = await g((g1.childIds || [])[0]);
        step('get(tab0)', t1 ? { id: t1.id, type: t1.type, title: (t1.title || '').slice(0, 60), url: (t1.url || '').slice(0, 80), keys: Object.keys(t1) } : t1);
      }
      // 顺便测 20 个连续 get 的耗时
      const t0 = performance.now();
      for (let i = 0; i < Math.min(20, root.childIds.length); i++) await g(root.childIds[i]);
      step('20gets_ms', Math.round(performance.now() - t0));
    }
    // 对照：getAll 是否为空、索引查询是否为空（确认扫描类读取的病）
    const all = await new Promise((res) => { const r = store.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res('ERR'); setTimeout(() => res('TIMEOUT'), 4000); });
    step('getAll', Array.isArray(all) ? { n: all.length } : String(all));
    const idxq = await new Promise((res) => { const r = store.index('type').getAll('group'); r.onsuccess = () => res(r.result || []); r.onerror = () => res('ERR'); setTimeout(() => res('TIMEOUT'), 4000); });
    step('index(type=group)', Array.isArray(idxq) ? { n: idxq.length } : String(idxq));
    const c = await new Promise((res) => { const r = store.count(); r.onsuccess = () => res(r.result); r.onerror = () => res('ERR'); setTimeout(() => res('TIMEOUT'), 4000); });
    step('count', c);
    // 复刻模块状态
    step('otvz.replica', window.__otvz ? window.__otvz.replica : null);
    step('replicaDom', { shell: !!document.querySelector('[data-otvz-replica]'), listRows: document.querySelectorAll('[data-otvz-replica] .tab').length });
    try { db.close(); } catch (e) {}
  } catch (e) { step('store.fail', String(e)); }
  return { log };
})()`;

async function main() {
  const report = { when: new Date().toISOString(), headless: HEADLESS };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('扩展未加载: ' + EXT);
  report.extId = match.id;

  const profileDir = labTmpDir('profile-idb-probe4');
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
    cdp.on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) report.errors.push(((p.exceptionDetails || {}).exception || {}).description || (p.exceptionDetails || {}).text || ''); });

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
    try {
      await waitFor(async () => {
        const s = await evalJs('document.querySelectorAll(".tab").length');
        return typeof s === 'number' && s >= 4000;
      }, { timeout: 45000, interval: 500, label: '列表渲染出现' });
    } catch (e) {
      report.stuck = true;
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
    await sleep(1200);

    report.trace = await evalJs(TRACE);
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

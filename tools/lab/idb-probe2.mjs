// idb-probe2.mjs — 验证「root.childIds 树序 = DOM 显示序」+ 抓完整模板 + 标定日期格式 + 测定向读取耗时
// 为首屏直出（replica）定案设计。
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
  || path.join('E:', path.sep, 'CCSpace', 'cache', 'tmp', 'onetab-lab', 'results', 'idb-probe2.json');
const PORT = parseInt(process.env.ONETAB_IDB_PORT || '9391', 10);
const HEADLESS = !process.argv.includes('--windowed');

const EXPLORE = `(async () => {
  const T = { t0: performance.now() };
  const db = await new Promise((res, rej) => { const r = indexedDB.open('onetab', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  T.tOpen = performance.now();
  const tx = db.transaction('item', 'readonly');
  const store = tx.objectStore('item');
  const groups = await new Promise((res) => { const q = store.index('type').getAll('group'); q.onsuccess = () => res(q.result); });
  T.tGroups = performance.now();
  const gmap = new Map(groups.map((g) => [g.id, g]));
  const root = await new Promise((res) => { const q = store.get('root'); q.onsuccess = () => res(q.result); });
  const trash = await new Promise((res) => { const q = store.get('trash'); q.onsuccess = () => res(q.result); });
  const quickList = await new Promise((res) => { const q = store.get('quickList'); q.onsuccess = () => res(q.result); });
  // 树序：root.childIds 深度优先，跳过 trash 子树
  const skip = new Set(['trash']);
  const stack = [...(trash ? trash.childIds || [] : [])];
  while (stack.length) { const id = stack.pop(); skip.add(id); const g = gmap.get(id); if (g && g.childIds) stack.push(...g.childIds); }
  const orderedGroups = [];
  const walkStack = [...(root.childIds || [])].reverse();
  while (walkStack.length) {
    const id = walkStack.pop();
    if (skip.has(id)) continue;
    const g = gmap.get(id);
    if (!g) continue;
    if (g.groupType === 'tabGroup') orderedGroups.push(g.id);
    if (g.childIds) walkStack.push(...[...g.childIds].reverse());
  }
  T.tWalk = performance.now();
  // DOM 序
  const domGroups = [...document.querySelectorAll('#centerColItems > .tabGroup')].map((g) => g.dataset.id);
  // 首页 tab 记录：前 3 个组的 childIds 前 40 个
  const tabsByGroup = {};
  for (const gid of orderedGroups.slice(0, 3)) {
    const g = gmap.get(gid);
    const ids = (g.childIds || []).slice(0, 40);
    const arr = [];
    for (const tid of ids) {
      const rec = await new Promise((res) => { const q = store.get(tid); q.onsuccess = () => res(q.result); });
      if (rec) arr.push(rec);
    }
    tabsByGroup[gid] = arr;
  }
  T.tTabs = performance.now();
  // DOM 组详情：前 10 组
  const domEls = [...document.querySelectorAll('#centerColItems > .tabGroup')].slice(0, 10);
  const headers = domEls.map((g) => {
    const label = g.querySelector('.tabGroupLabelText span');
    const fold = g.querySelector('.foldButton');
    const dateDiv = fold && fold.parentElement ? fold.parentElement.firstElementChild : null;
    return {
      id: g.dataset.id,
      label: label ? label.textContent : null,
      dateLine: dateDiv ? dateDiv.textContent.trim() : null,
      foldLabel: fold ? fold.getAttribute('aria-label') : null,
      bodyDisplay: (function(){ const b=g.querySelector('.tabGroupBody'); const kids=b?b.children:[]; for(const k of kids){ if(k!==fold?.closest('.tabGroupBody>div')&&k.style&&k.style.display==='none') return 'some-child-none'; } return 'none-hidden'; })(),
      firstTabHref: (g.querySelector('.tab a')||{}).href || null,
    };
  });
  // favicon 样本
  const favs = [...document.querySelectorAll('#centerColItems > .tabGroup')].slice(0, 2)
    .flatMap((g) => [...g.querySelectorAll('.tab')])
    .slice(0, 10)
    .map((t) => {
      const d = t.querySelector('.favIconDiv > div');
      const a = t.querySelector('a.tabLink');
      return { href: a ? a.href.slice(0, 120) : null, bgX: d ? d.style.backgroundPositionX : null, bgY: d ? d.style.backgroundPositionY : null, img: d && d.querySelector('img') ? d.querySelector('img').src.split('/').pop() : null };
    });
  // 完整外层 HTML（前 2 组，全量）
  const fullHTML = [...document.querySelectorAll('#centerColItems > .tabGroup')].slice(0, 2).map((g) => ({ id: g.dataset.id, html: g.outerHTML }));
  db.close();
  return {
    timing: T,
    rootChildCount: root ? (root.childIds || []).length : null,
    rootHead: root ? (root.childIds || []).slice(0, 8) : null,
    special: { trash: trash ? { id: trash.id, groupType: trash.groupType, childCount: (trash.childIds || []).length } : null, quickList: quickList ? { id: quickList.id, groupType: quickList.groupType, childCount: (quickList.childIds || []).length } : null },
    groupSample: groups.find((g) => g.groupType === 'tabGroup') || null,
    folderSample: groups.find((g) => g.groupType === 'folder' && g.id !== 'root' && g.id !== 'trash') || null,
    orderMatch: { computedFirst12: orderedGroups.slice(0, 12), domFirst12: domGroups.slice(0, 12), orderedTotal: orderedGroups.length, domTotal: domGroups.length, match12: JSON.stringify(orderedGroups.slice(0, 12)) === JSON.stringify(domGroups.slice(0, 12)) },
    headers,
    favs,
    tabsFirstGroup: tabsByGroup[orderedGroups[0]] ? tabsByGroup[orderedGroups[0]].slice(0, 6) : null,
    tabsSecondGroup: tabsByGroup[orderedGroups[1]] ? tabsByGroup[orderedGroups[1]].slice(0, 3) : null,
    fullHTML,
  };
})()`;

async function main() {
  const report = { when: new Date().toISOString(), headless: HEADLESS };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('扩展未加载: ' + EXT);
  report.extId = match.id;

  const profileDir = labTmpDir('profile-idb-probe2');
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
    try {
      await waitFor(async () => {
        const s = await evalJs('document.querySelectorAll(".tab").length');
        return typeof s === 'number' && s >= 4000;
      }, { timeout: 45000, interval: 500, label: '列表渲染出现' });
    } catch (e) {
      report.firstTryStuck = await evalJs(`({ tabs: document.querySelectorAll('.tab').length, spinner: !!document.getElementById('loadingSpinner'), ready: document.readyState })`);
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

    report.explore = await evalJs(EXPLORE);
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

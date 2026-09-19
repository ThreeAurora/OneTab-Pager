// idb-probe3.mjs — 抓官方列容器包装链计算样式 + 非雪碧图 favicon 样本 + 自定义标题组样本
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
  || path.join('E:', path.sep, 'CCSpace', 'cache', 'tmp', 'onetab-lab', 'results', 'idb-probe3.json');
const PORT = parseInt(process.env.ONETAB_IDB_PORT || '9392', 10);
const HEADLESS = !process.argv.includes('--windowed');

const EXPLORE = `(() => {
  const cci = document.getElementById('centerColItems');
  const cad = document.getElementById('contentAreaDiv');
  const props = ['display','maxWidth','width','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','overflowY','overflowX','boxSizing','position','direction'];
  const dump = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const o = { tag: el.tagName, id: el.id || null, cls: el.className || null, styleAttr: el.getAttribute('style'), inline: el.style.cssText || null };
    for (const p of props) o[p] = cs[p];
    return o;
  };
  const chain = [];
  let n = cci;
  while (n && n !== document.body) { chain.unshift(dump(n)); n = n.parentElement; }
  // 非雪碧图 favicon 样本：找 favIconDiv 里含 img 的行
  const globeRows = [...document.querySelectorAll('.favIconDiv')].filter((d) => d.querySelector('img')).slice(0, 4).map((d) => d.parentElement.parentElement.outerHTML.slice(0, 1400));
  // 自定义标题组
  const custom = [];
  for (const g of document.querySelectorAll('#centerColItems > .tabGroup')) {
    const lab = g.querySelector('.tabGroupLabelText span');
    if (lab && !/^[0-9]+ 个标签页$/.test(lab.textContent.trim())) {
      custom.push({ id: g.dataset.id, label: lab.textContent.trim().slice(0, 80), headerHTML: g.outerHTML.slice(0, 4500) });
      if (custom.length >= 2) break;
    }
  }
  // 折叠组样本
  let folded = null;
  for (const g of document.querySelectorAll('#centerColItems > .tabGroup')) {
    const fb = g.querySelector('.foldButton picture');
    if (fb && !/rotate\\(90deg\\)/.test(fb.getAttribute('style') || '')) { folded = { id: g.dataset.id, foldPictureStyle: fb.getAttribute('style'), bodyStyle: g.querySelector('.tabGroupBody').getAttribute('style'), afterFoldDiv: (g.querySelector('.foldButton').nextElementSibling || {}).outerHTML }; break; }
  }
  return { chain, globeRows, custom, folded, spinnerDisplay: getComputedStyle(document.getElementById('loadingSpinner') || document.body).display, bodyDir: getComputedStyle(document.body).direction };
})()`;

async function main() {
  const report = { when: new Date().toISOString(), headless: HEADLESS };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('扩展未加载: ' + EXT);
  report.extId = match.id;

  const profileDir = labTmpDir('profile-idb-probe3');
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

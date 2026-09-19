// clone-probe.mjs — 量「复刻列表到底是复制了一份全量，还是只物化了第一页」。
//
// 背景：主人报「点插件按钮→加载完成后，好像直接加载了所有标签页（全量）给了我一个全量的大页面」。
// 复刻壳（[data-otvz-replica]）里只有 rpLoad() 装进去的那一页，行数就数十来行；但复刻期为
// 了让官方分片渲染继续跑，官方列容器只是 opacity:0（布局照常）。所以要量化三件事：
//   1. 复刻列表自己的 DOM 行数 / 组数 / 渲染高度；
//   2. 复刻期官方隐藏列表已经物化了多少行、多高（这才是「全量页面」的真身）；
//   3. 复刻期滚动容器的 scrollHeight 是谁贡献的。
// 顺带采样主线程长任务，判断那几秒有没有被"全量布局"卡住。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, listTargets, closeTarget } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const EXT = path.join(PROJECT, 'OneTab-patched-unpacked');
const OUT = process.env.ONETAB_PROBE_OUT
  || path.join('E:', path.sep, 'CCSpace', 'cache', 'tmp', 'onetab-lab', 'results', 'clone-probe.json');
const PORT = parseInt(process.env.ONETAB_PROBE_PORT || '9381', 10);
const SAMPLE_MS = parseInt(process.env.ONETAB_PROBE_SAMPLE || '9000', 10);

const PROBE = `(() => {
  const rep = document.querySelector('[data-otvz-replica]');
  const sc = rep ? rep.querySelector('[data-otvz-replica-scroller]') : null;
  const list = rep ? rep.querySelector('[data-otvz-replica-list]') : null;
  const cad = document.getElementById('contentAreaDiv');
  const kids = cad ? [...cad.children] : [];
  const official = kids.filter(k => !(k.getAttribute && k.getAttribute('data-otvz-replica')));
  const off = official.length ? official[official.length - 1] : null;
  const offScroller = off ? off.querySelector('*[style*="overflow"]') : null;
  const rectOf = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) }; };
  return {
    replica: {
      present: !!rep,
      listRows: list ? list.querySelectorAll('.tab').length : 0,
      listGroups: list ? list.querySelectorAll('.tabGroup').length : 0,
      listChildren: list ? list.children.length : 0,
      listHeight: list ? Math.round(list.getBoundingClientRect().height) : 0,
      scrollerHeight: sc ? Math.round(sc.getBoundingClientRect().height) : 0,
      scrollerScrollH: sc ? sc.scrollHeight : 0,
    },
    official: {
      present: !!off,
      rowsInDom: off ? off.querySelectorAll('.tab').length : 0,
      groupsInDom: off ? off.querySelectorAll('.tabGroup').length : 0,
      height: off ? Math.round(off.getBoundingClientRect().height) : 0,
      opacity: off ? off.style.opacity : null,
      pe: off ? off.style.pointerEvents : null,
      cv: off ? off.style.contentVisibility : null,
      scrollerScrollH: offScroller ? offScroller.scrollHeight : null,
      scrollerH: rectOf(offScroller),
    },
    cadKids: kids.length,
    state: window.__otvz ? window.__otvz.pageState : null,
    replicaState: window.__otvz ? window.__otvz.replica : null,
    hideMs: window.__otvz ? (window.__otvz.replicaHideMs || null) : null,
    longTasks: window.__cloneLT ? window.__cloneLT.length : 0,
    longTasksTotal: window.__cloneLT ? Math.round(window.__cloneLT.reduce((a, b) => a + b, 0)) : 0,
    maxLongTask: window.__cloneLT ? Math.round(Math.max(0, ...window.__cloneLT)) : 0,
  };
})()`;

async function main() {
  const report = { when: new Date().toISOString(), port: PORT, timeline: [], errors: [] };
  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('扩展未加载: ' + EXT);
  report.extId = match.id;

  // 唯一 profile 目录：复用会残留 session，导致 "Session with given id not found"
  const profileDir = labTmpDir('profile-clone-' + PORT);
  prepareProfile({ extId: match.id, profileDir });

  let died = null;
  const edge = await launchEdge({ profileDir, extDir: EXT, port: PORT, headless: true, onExit: (e) => { died = e; } });

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
    cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid === sessionId) report.errors.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 300));
    });

    // 长任务采样钩子：导航前注入（addScriptToEvaluateOnNewDocument）
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__cloneLT=[];try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){window.__cloneLT.push(e.duration);});}).observe({entryTypes:['longtask']});}catch(e){}`,
    }, sessionId);

    const evalProbe = async () => {
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId);
        return r.exceptionDetails ? { evalErr: r.exceptionDetails.text } : r.result?.value;
      } catch (e) { return { evalErr: e.message }; }
    };

    const t0 = Date.now();
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await new Promise((resolve) => {
      const to = setTimeout(resolve, 60000);
      cdp.on('Page.loadEventFired', (p, sid) => { if (sid === sessionId) { clearTimeout(to); resolve(); } });
    });
    report.navMs = Date.now() - t0;

    const deadline = t0 + SAMPLE_MS;
    while (Date.now() < deadline) {
      const s = await evalProbe();
      report.timeline.push({ t: Date.now() - t0, ...s });
      await sleep(200);
    }

    // 稳态再采一次（换装之后）
    await sleep(3000);
    report.steady = await evalProbe();
    if (died) report.browserExited = died;
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

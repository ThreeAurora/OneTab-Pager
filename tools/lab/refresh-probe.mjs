// refresh-probe.mjs — 复现「刷新后翻页条消失」bug
//
// 流程：启动隔离 Edge（真实数据）→ 打开 onetab.html → 等渲染稳态 → 记录稳态 A
//       → Page.reload() → 每 250ms 采样 30 秒（翻页条数量/页面状态/console）
//       → 输出时间线 JSON
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
  || path.join('E:', path.sep, 'CCSpace', 'cache', 'tmp', 'onetab-lab', 'results', 'refresh-probe.json');
const PORT = parseInt(process.env.ONETAB_PROBE_PORT || '9361', 10);
const HEADLESS = !process.argv.includes('--windowed');
const ROUNDS = parseInt(process.env.ONETAB_PROBE_ROUNDS || '3', 10);   // 刷新轮数
const SAMPLE_MS = parseInt(process.env.ONETAB_PROBE_SAMPLE || '12000', 10); // 每轮采样时长

const SNAP = `(() => {
  const v = window.__otvz;
  let pt = null;
  const top = document.querySelector('.otvz-pager-top');
  if (top) pt = top.style.display === '' ? 'auto' : top.style.display;
  return {
    tabs: document.querySelectorAll('.tab').length,
    groups: document.querySelectorAll('.tabGroup').length,
    pagers: document.querySelectorAll('.otvz-pager').length,
    pagerTopDisplay: pt,
    state: v ? v.pageState : null,
    replica: v ? v.replica : null,
    replicaInDom: !!document.querySelector('[data-otvz-replica]'),
    pendingCtl: document.querySelectorAll('[data-otvz-replica] [data-otvz-pending]').length,
    pendingCtlStyled: (() => { const e = document.querySelector('[data-otvz-replica] [data-otvz-pending]'); if (!e) return null; const c = getComputedStyle(e); return { opacity: c.opacity, pe: c.pointerEvents, anim: c.animationName }; })(),
    syncs: v ? v.stats.syncs : null,
    lastSyncMs: v ? v.stats.lastSyncMs : null,
    spinner: !!document.getElementById('loadingSpinner'),
    contentKids: (document.getElementById('contentAreaDiv') || { children: [] }).children.length,
    ready: document.readyState,
  };
})()`;

async function main() {
  const report = { when: new Date().toISOString(), headless: HEADLESS, phases: [], console: [], errors: [] };

  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === EXT.toLowerCase());
  if (!match) throw new Error('扩展未加载: ' + EXT);
  report.extId = match.id;

  const profileDir = labTmpDir('profile-refresh-probe');
  prepareProfile({ extId: match.id, profileDir });

  let died = null;
  const edge = await launchEdge({ profileDir, extDir: EXT, port: PORT, headless: HEADLESS, onExit: (e) => { died = e; } });

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

    // 开标签页（bench 同款：让扩展自己开，确保扩展上下文完整）
    await swEval('chrome.tabs.create({url:"about:blank", active:true})');
    const pageTarget = await waitFor(async () => {
      const ts = await listTargets(cdp);
      return ts.find((t) => t.type === 'page' && t.url === 'about:blank') || null;
    }, { timeout: 25000, interval: 200, label: '新标签页' });
    targetId = pageTarget.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    // headless 下页面必须被「激活」，否则官方 OneTab 的分片渲染（rIC）不跑
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
    cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid === sessionId) report.console.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    });

    const evalSnap = async () => {
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: SNAP, returnByValue: true }, sessionId);
        return r.exceptionDetails ? { evalErr: r.exceptionDetails.text } : r.result?.value;
      } catch (e) { return { evalErr: e.message }; }
    };

    // ---- 阶段 1：首次导航 ----
    let t0 = Date.now();
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await new Promise((resolve) => {
      const to = setTimeout(resolve, 60000);
      cdp.on('Page.loadEventFired', (p, sid) => { if (sid === sessionId) { clearTimeout(to); resolve(); } });
    });
    report.phases.push({ ph: 'firstLoad', ms: Date.now() - t0 });

    // ---- 阶段 2：等渲染稳态（.tab 数量 ≥ 4000 且连续 2 次 1s 采样不变）----
    t0 = Date.now();
    try {
      await waitFor(async () => {
        const s = await evalSnap();
        return s && s.tabs >= 4000;
      }, { timeout: 90000, interval: 500, label: '列表渲染出现' });
    } catch (e) {
      // 超时现场：官方列容器在不在、是不是被复刻藏过、复刻壳/条各自如何
      report.stuckDiag = await (async () => {
        const r = await cdp.send('Runtime.evaluate', {
          expression: `(() => {
            const cad = document.getElementById('contentAreaDiv');
            const kids = cad ? [...cad.children].map(k => ({ tag: k.tagName, rep: k.getAttribute && k.getAttribute('data-otvz-replica'), opacity: k.style.opacity, vis: k.style.visibility, kids: k.children.length })) : null;
            const official = cad ? [...cad.children].filter(k => !(k.getAttribute && k.getAttribute('data-otvz-replica')))[0] : null;
            const v = window.__otvz;
            return {
              contentKids: kids,
              officialOpacity: official ? official.style.opacity : null,
              officialText: official ? (official.textContent || '').slice(0, 60) : null,
              officialRows: official ? official.querySelectorAll('.tab').length : null,
              spinner: !!document.getElementById('loadingSpinner'),
              replica: v ? v.replica : null,
              state: v ? v.pageState : null,
              stats: v ? v.stats : null,
              repRowsInDom: document.querySelectorAll('[data-otvz-replica] .tab').length,
              pagers: document.querySelectorAll('.otvz-pager').length,
              bodyText: (document.body.innerText || '').slice(0, 120),
            };
          })()`, returnByValue: true,
        }, sessionId);
        return r.result ? r.result.value : null;
      })();
      throw e;
    }
    let prev = -1, stable = 0;
    while (stable < 2) {
      await sleep(1000);
      const s = await evalSnap();
      if (s && s.tabs === prev && s.tabs > 0) stable++; else stable = 0;
      prev = s ? s.tabs : -1;
      if (Date.now() - t0 > 60000) break;
    }
    const steadyA = await evalSnap();
    report.steadyA = steadyA;
    report.phases.push({ ph: 'settleA', ms: Date.now() - t0 });
    report.steadyDiag = {
      officialOpacity: await (async () => {
        const r = await cdp.send('Runtime.evaluate', {
          expression: `(() => { const cad = document.getElementById('contentAreaDiv'); if (!cad) return null; const o = [...cad.children].filter(k => !(k.getAttribute && k.getAttribute('data-otvz-replica')))[0]; return o ? { opacity: o.style.opacity, pointer: o.style.pointerEvents, rows: o.querySelectorAll('.tab').length, textLen: (o.textContent || '').length } : null; })()`,
          returnByValue: true,
        }, sessionId);
        return r.result ? r.result.value : null;
      })(),
    };

    // ---- 阶段 3：循环刷新 ROUNDS 轮 + 采样 ----
    report.rounds = [];
    for (let round = 1; round <= ROUNDS; round++) {
      const reloadAt = Date.now();
      await cdp.send('Page.reload', {}, sessionId);
      await new Promise((resolve) => {
        const to = setTimeout(resolve, 60000);
        const h = (p, sid) => { if (sid === sessionId) { clearTimeout(to); resolve(); } };
        cdp.on('Page.loadEventFired', h);
      });
      // reload 后页面生命周期可能回到被动，再激活一次
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
      await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});

      const timeline = [];
      const deadline = reloadAt + SAMPLE_MS;
      while (Date.now() < deadline) {
        const s = await evalSnap();
        timeline.push({ t: Date.now() - reloadAt, ...s });
        await sleep(250);
      }
      const lastPagers = timeline.slice(-3).map((s) => s.pagers);
      const minPagersAfter3s = timeline.filter((s) => s.t > 3000).reduce((m, s) => Math.min(m, s.pagers), 99);
      const firstRows = (timeline.find((s) => s.replica && s.replica.rows > 0) || {}).t;
      const firstSwap = (timeline.find((s) => s.replica && s.replica.swapped) || {}).t;
      const replicaGone = (timeline.find((s) => s.t > 500 && !s.replicaInDom) || {}).t;
      const maxReplicaRows = timeline.reduce((m, s) => Math.max(m, (s.replica && s.replica.rows) || 0), 0);
      const maxPendingCtl = timeline.reduce((m, s) => Math.max(m, s.pendingCtl || 0), 0);
      const firstPendingStyled = (timeline.find(s => s.pendingCtlStyled) || {}).pendingCtlStyled || null;
      report.rounds.push({ round, finalPagers: lastPagers, minPagersAfter3s,
        replicaFirstRowsMs: firstRows ?? null, replicaSwapMs: firstSwap ?? null,
        replicaGoneMs: replicaGone ?? null, maxReplicaRows, maxPendingCtl, firstPendingStyled,
        finalState: timeline[timeline.length - 1], samples: timeline.length });
      report[`timeline_r${round}`] = timeline;
    }

    const finalA = await evalSnap();
    report.finalState = finalA;
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

// bench.mjs — OneTab 列表页性能实测台（主驱动）
//
// 用法：
//   node bench.mjs                          # 用 ../OneTab-patched-unpacked 跑一次
//   node bench.mjs --ext "D:\some\ext" --out result.json --keep
//
// 流程：准备一次性 profile（含主人真实数据副本）→ 启动隔离 Edge → 由扩展自己打开列表页 →
//       分阶段跑测量（每阶段独立超时）→ 输出 JSON → 关闭 Edge。
// 全程不碰主人正在使用的 Edge profile。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, closeTarget, listTargets } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';
import { PHASES_SOURCE } from './phases.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const DEFAULT_EXT = path.join(PROJECT, 'OneTab-patched-unpacked');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const extDir = path.resolve(arg('ext', DEFAULT_EXT));
const label = arg('label', path.basename(extDir));
const port = parseInt(arg('port', '9333'), 10);
const PHASES = (arg('phases', 'p0,p1,p2,p3,p4,p5')).split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUTS = { p0: 70000, p1: 40000, p2: 30000, p3: 60000, p4: 40000, p5: 40000, p6: 30000, p7: 40000, p8: 60000, p9: 150000, p10: 30000, p11: 90000, p12: 60000, p3b: 40000 };
const outFile = arg('out', path.join(labTmpDir('results'),
  `${label}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`));

/**
 * 滚动 N 秒，量「主线程到底干了多少活」。
 *
 * 为什么不测帧率：本机无论带窗口还是 headless，rAF 都被节流到约 1Hz
 * （headless=new 也没躲过），「平均帧间隔」拿不到有效值。
 * 改用 CDP 的 Performance 累计计数器 —— LayoutDuration / RecalcStyleDuration /
 * ScriptDuration / TaskDuration 都是累计秒数，滚动前后取增量即可知道主线程
 * 被占用多少毫秒。这与「手感顺不顺」直接对应，且完全不依赖 rAF。
 *
 * 顺便在每次滚动后做一次 elementFromPoint，采样命中测试耗时（鼠标悬停的代价）。
 */
async function scrollAB(cdp, sessionId, seconds, tag) {
  const readMetrics = async () => {
    const m = await cdp.send('Performance.getMetrics', {}, sessionId);
    const o = {};
    for (const x of m.metrics) o[x.name] = x.value;
    return o;
  };
  const a = await readMetrics();

  const started = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const sc = (() => {
        for (let n = document.querySelector('.tab'); n; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 10) return n;
        }
        return document.scrollingElement;
      })();
      if (!sc) return { error: '找不到滚动容器' };
      window.__ab = { sc, hits: [], stop: false, pos: 0, dir: 1 };
      const H = window.__ab;
      const tick = () => {
        if (H.stop) return;
        const max = Math.max(1, sc.scrollHeight - sc.clientHeight);
        H.pos += 900 * H.dir;
        if (H.pos > max) { H.pos = max; H.dir = -1; }
        if (H.pos < 0) { H.pos = 0; H.dir = 1; }
        sc.scrollTop = H.pos;
        const r = sc.getBoundingClientRect();
        const t = performance.now();
        document.elementFromPoint(r.left + r.width * 0.5, r.top + Math.min(300, r.height * 0.5));
        H.hits.push(performance.now() - t);
        setTimeout(tick, 16);
      };
      setTimeout(tick, 16);
      return { ok: true, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight };
    })()`, returnByValue: true,
  }, sessionId);

  await sleep(seconds * 1000);

  const fin = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const H = window.__ab; if (!H) return null;
      H.stop = true;
      const h = H.hits.slice().sort((x, y) => x - y);
      const q = (p) => h.length ? +h[Math.min(h.length - 1, Math.floor(h.length * p))].toFixed(3) : null;
      return {
        ticks: h.length,
        hitP50: q(0.5), hitP95: q(0.95), hitMax: h.length ? +h[h.length - 1].toFixed(3) : null,
        scrollHeightAfter: H.sc.scrollHeight,
        scrollTopAfter: Math.round(H.sc.scrollTop),
      };
    })()`, returnByValue: true,
  }, sessionId);

  await sleep(500);
  const b = await readMetrics();
  const d = (k) => +(((b[k] ?? 0) - (a[k] ?? 0)) * 1000).toFixed(1);   // 计数器是秒，换成毫秒

  return {
    tag, seconds,
    start: started.result?.value ?? null,
    ...(fin.result?.value ?? {}),
    mainThread: {
      layoutCount: (b.LayoutCount ?? 0) - (a.LayoutCount ?? 0),
      layoutMs: d('LayoutDuration'),
      recalcCount: (b.RecalcStyleCount ?? 0) - (a.RecalcStyleCount ?? 0),
      recalcMs: d('RecalcStyleDuration'),
      scriptMs: d('ScriptDuration'),
      taskMs: d('TaskDuration'),
      busyPercent: +(((b.TaskDuration ?? 0) - (a.TaskDuration ?? 0)) / seconds * 100).toFixed(1),
    },
  };
}

/** p9：同页 A/B —— 先测补丁开着，再 kill 掉补丁测官方原状。 */
async function runScrollAB(cdp, sessionId) {
  const patched = await scrollAB(cdp, sessionId, 5, '补丁开');
  const k = await cdp.send('Runtime.evaluate', {
    expression: 'window.__otvz ? window.__otvz.kill() : null', returnByValue: true,
  }, sessionId);
  await sleep(1500);
  const official = await scrollAB(cdp, sessionId, 5, '补丁关（官方原状）');
  return { patched, official, killResult: k.result?.value ?? null };
}

async function main() {
  console.log('=== OneTab 性能实测台 ===');
  console.log('标签     :', label);
  console.log('扩展目录 :', extDir);
  if (!fs.existsSync(extDir)) throw new Error('扩展目录不存在: ' + extDir);

  const unpacked = readUnpackedExtensions(realUserDataDir());
  const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === extDir.toLowerCase());
  if (!match) throw new Error('该目录不是已加载的解压扩展:\n' + unpacked.map((u) => '  ' + u.path).join('\n'));
  console.log('扩展 ID  :', match.id);

  const profileDir = labTmpDir('profile-' + label.replace(/[^\w.-]/g, '_'));
  const { copied } = prepareProfile({ extId: match.id, profileDir });
  console.log('带入数据 :', copied.length ? copied.join(', ') : '（空）');

  let died = null;
  const headless = process.argv.includes('--headless');
  const edge = await launchEdge({ profileDir, extDir, port, headless, onExit: (e) => { died = e; } });
  console.log('Edge pid :', edge.pid, headless ? '(headless)' : '(有窗口)');

  let cdp;
  const report = { label, when: new Date().toISOString(), extDir, extId: match.id, phases: {}, errors: [], console: [] };
  try {
    ({ cdp } = await connectBrowser(edge.base));
    const { id } = await findExtensionId(cdp, match.id);
    report.extId = id;
    const pageUrl = `chrome-extension://${id}/onetab.html`;

    const swTarget = (await listTargets(cdp)).find((t) => t.type === 'service_worker' && new URL(t.url).host === id);
    if (!swTarget) throw new Error('找不到扩展的 service worker');
    const { sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, swSession);

    // service worker 会休眠/冷启动，第一次调用 chrome.tabs 可能拿不到 —— 先等它就绪，
    // 再带重试地开标签页，否则整轮测试会被一个偶发的 undefined 打断。
    const swEval = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSession);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    };
    await waitFor(async () => {
      try { return !!(await swEval('typeof chrome!=="undefined" && chrome.tabs && typeof chrome.tabs.create==="function"')); }
      catch { return false; }
    }, { timeout: 20000, interval: 300, label: 'service worker 的 tabs API 就绪' });

    const before = new Set((await listTargets(cdp)).map((t) => t.targetId));
    let createdId = null;
    for (let attempt = 0; attempt < 3 && createdId == null; attempt++) {
      try {
        createdId = await swEval('chrome.tabs.create({url:"about:blank", active:true}).then(t=>t&&t.id)');
      } catch (e) {
        console.log('  (开标签页失败，重试:', e.message.slice(0, 80), ')');
        await sleep(800);
      }
    }
    if (createdId == null) throw new Error('无法通过扩展打开新标签页（chrome.tabs.create 三次都失败）');
    const pageTarget = await waitFor(async () => {
      const ts = await listTargets(cdp);
      return ts.find((t) => t.type === 'page' && t.url === 'about:blank' && !before.has(t.targetId)) || null;
    }, { timeout: 25000, interval: 200, label: '新标签页' });

    const targetId = pageTarget.targetId;
    const sessionId = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    report.targetId = targetId;

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Performance.enable', {}, sessionId);
    // 把本标签页提到最前，配合启动参数一起绕开 rAF 节流
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    // 窗口若被判为遮挡/后台，rAF 会被压到 1 帧/秒，滚动帧率就无从测起。
    // 三重保险：把窗口恢复成普通状态、挪到屏幕左上、并把页面生命周期显式置为 active。
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId }, sessionId);
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1400, height: 950 } });
    } catch (e) { console.log('  (窗口置前失败:', e.message, ')'); }
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});

    cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid === sessionId) report.errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
    });
    cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid === sessionId) report.console.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    });

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__lab = { t0: performance.now(), firstRow: null, longtasks: [] };
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lab.longtasks.push({ start: e.startTime, dur: e.duration }); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
      try { new MutationObserver(() => { if (window.__lab.firstRow == null && document.querySelector('.tab')) window.__lab.firstRow = performance.now(); }).observe(document, { childList: true, subtree: true }); } catch (e) {}
    })();` }, sessionId);

    const navT0 = Date.now();
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    await new Promise((resolve) => {
      const to = setTimeout(resolve, 60000);
      cdp.on('Page.loadEventFired', (p, sid) => { if (sid === sessionId) { clearTimeout(to); resolve(); } });
    });
    report.loadMs = Date.now() - navT0;
    console.log('列表页已打开，load', report.loadMs, 'ms');

    // 预热：load 事件来得很快（100ms 级），但官方真正把 5000+ 条渲染进 DOM 要好几秒。
    // 纯官方状态下这段渲染会把主线程占满，连 setTimeout 都被拖慢，所以必须先在
    // Node 侧（不受页面阻塞影响）干等一会儿，各阶段测到的才是「渲染完之后」的稳态。
    const warmup = parseInt(arg('warmup', '0'), 10);
    if (warmup > 0) {
      process.stdout.write(`  预热等待 ${warmup}s ... `);
      await sleep(warmup * 1000);
      console.log('ok');
    }

    // 安装分阶段脚本
    await cdp.send('Runtime.evaluate', { expression: PHASES_SOURCE, returnByValue: true }, sessionId);

    for (const ph of PHASES) {
      const t0 = Date.now();
      process.stdout.write(`  ${ph} ... `);
      let value = null, err = null;
      try {
        if (ph === 'p9') {
          value = await runScrollAB(cdp, sessionId);
        } else {
          const r = await Promise.race([
            cdp.send('Runtime.evaluate', {
              expression: `window.__b.${ph}()`, awaitPromise: true, returnByValue: true,
            }, sessionId),
            sleep((TIMEOUTS[ph] || 40000) + 5000).then(() => { throw new Error('阶段超时（Node 侧）'); }),
          ]);
          if (r.exceptionDetails) err = '页面抛错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
          else value = r.result?.value ?? null;
        }
      } catch (e) { err = e.message; }
      const ms = Date.now() - t0;
      report.phases[ph] = value === null ? { error: err } : value;
      if (err) report.errors.push(`${ph}: ${err}`);
      console.log(err ? `✗ ${ms}ms  ${err}` : `✓ ${ms}ms`);
      if (err && /Edge|超时/.test(err) && died) break;
      if (died) { console.log('  ⚠️ 浏览器已退出，终止后续阶段'); break; }
    }

    const m = await cdp.send('Performance.getMetrics', {}, sessionId).catch(() => null);
    if (m) {
      const map = {};
      for (const x of m.metrics) map[x.name] = x.value;
      report.cdpMetrics = {
        Nodes: map.Nodes ?? null,
        LayoutCount: map.LayoutCount ?? null,
        RecalcStyleCount: map.RecalcStyleCount ?? null,
        JSHeapMB: map.JSHeapUsedSize ? +(map.JSHeapUsedSize / 1048576).toFixed(1) : null,
      };
    }
  } catch (e) {
    report.fatal = e.message;
    console.error('❌', e.message);
  } finally {
    if (died) report.browserExited = died;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n=== 结果 ===');
    console.log(JSON.stringify(report, null, 2));
    console.log('\n已保存:', outFile);
    try { if (cdp && report.targetId) await closeTarget(cdp, report.targetId); } catch { /* 忽略 */ }
    await sleep(200);
    edge.kill();
  }
}

main().catch((e) => { console.error('\n❌', e.message); process.exitCode = 1; });

// probe.mjs — 诊断探针：确认「官方列表页为什么没渲染 / 渲染成了什么」
//
// 做法：
//  1. 附着到扩展的 service worker，抓它的异常与日志（corePing 握手失败会体现在这里）
//  2. 用扩展自己的方式打开列表页（SW 里 chrome.tabs.create），与用户点图标完全一致
//  3. 等页面渲染，导出 body 文本 / DOM 节点数 / 关键类名计数

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareProfile, readUnpackedExtensions, realUserDataDir, labTmpDir } from './profile.mjs';
import { launchEdge, connectBrowser, findExtensionId, listTargets } from './launch.mjs';
import { sleep, waitFor } from './cdp.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dir, '..', '..', '..');
const extDir = path.resolve(process.argv[2] || path.join(PROJECT, 'OneTab-patched-unpacked'));
const port = 9334;

const unpacked = readUnpackedExtensions(realUserDataDir());
const match = unpacked.find((u) => path.resolve(u.path).toLowerCase() === extDir.toLowerCase());
if (!match) throw new Error('未在 Edge 中找到该解压扩展: ' + extDir);

const profileDir = labTmpDir('profile-probe');
const { copied } = prepareProfile({ extId: match.id, profileDir });
console.log('数据带入:', copied.join(', ') || '(空)');

const edge = await launchEdge({ profileDir, extDir, port });
let cdp;
try {
  ({ cdp } = await connectBrowser(edge.base));
  const { id: extId } = await findExtensionId(cdp, match.id);
  console.log('扩展 ID:', extId);

  // ---- 1) 附着到 service worker，抓异常 ----
  const swTarget = (await listTargets(cdp)).find(
    (t) => t.type === 'service_worker' && new URL(t.url).host === extId);
  const swErrors = [], swLogs = [];
  let swSession = null;
  if (swTarget) {
    ({ sessionId: swSession } = await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true }));
    await cdp.send('Runtime.enable', {}, swSession);
    await cdp.send('Log.enable', {}, swSession).catch(() => {});
    cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid === swSession) swErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
    });
    cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid === swSession) swLogs.push(p.type + ': ' + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });
    console.log('已附着 service worker');
  } else {
    console.log('⚠️ 没找到 service worker target');
  }

  // ---- 2) 用扩展自己的方式打开列表页 ----
  const pageUrl = `chrome-extension://${extId}/onetab.html`;
  const before = new Set((await listTargets(cdp)).map((t) => t.targetId));
  if (swSession) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `chrome.tabs.create({url:${JSON.stringify(pageUrl)}}).then(t=>'ok:'+t.id).catch(e=>'err:'+e.message)`,
      awaitPromise: true, returnByValue: true,
    }, swSession);
    console.log('SW 里 chrome.tabs.create →', r.result?.value);
  } else {
    await cdp.send('Target.createTarget', { url: pageUrl });
  }

  // 找到新出现的 page target
  const pageTarget = await waitFor(async () => {
    const ts = await listTargets(cdp);
    return ts.find((t) => t.type === 'page' && t.url.startsWith(pageUrl) && !before.has(t.targetId)) || null;
  }, { timeout: 15000, interval: 300, label: '列表页 target 出现' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid === sessionId) pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });

  // ---- 3) 等到渲染稳定 ----
  const t0 = Date.now();
  let last = -1, stableFor = 0, state = null;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const r = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        tabs: document.querySelectorAll('.tab').length,
        groups: document.querySelectorAll('.tabGroup').length,
        nodes: document.getElementsByTagName('*').length,
        text: document.body.innerText.slice(0,200),
        spinner: !!document.getElementById('loadingSpinner')
      })`, returnByValue: true,
    }, sessionId);
    state = JSON.parse(r.result.value);
    if (state.tabs === last && state.tabs > 0) { stableFor += 500; if (stableFor >= 2500) break; }
    else stableFor = 0;
    last = state.tabs;
    if (i % 6 === 0) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  tab=${state.tabs} nodes=${state.nodes}`);
  }

  console.log('\n=== 页面状态 ===');
  console.log(JSON.stringify(state, null, 2));
  console.log('耗时', Date.now() - t0, 'ms');

  // 页面里直接 ping 一次，看后台答什么
  const ping = await cdp.send('Runtime.evaluate', {
    expression: `chrome.runtime.sendMessage({args:[],type:"corePing",Hp:true}).then(r=>'ok:'+JSON.stringify(r)).catch(e=>'err:'+e.message)`,
    awaitPromise: true, returnByValue: true,
  }, sessionId).catch((e) => ({ result: { value: 'evaluate 失败 ' + e.message } }));
  console.log('\n页面内 corePing →', ping.result?.value);

  console.log('\n=== service worker 异常 ===');
  console.log(swErrors.length ? swErrors.join('\n---\n') : '(无)');
  console.log('=== service worker 日志 ===');
  console.log(swLogs.slice(-20).join('\n') || '(无)');
  console.log('=== 页面异常 ===');
  console.log(pageErrors.length ? pageErrors.join('\n---\n') : '(无)');

  fs.writeFileSync(path.join(labTmpDir('results'), 'probe.json'),
    JSON.stringify({ state, swErrors, swLogs, pageErrors, ping: ping.result?.value }, null, 2));
} finally {
  await sleep(300);
  edge.kill();
}

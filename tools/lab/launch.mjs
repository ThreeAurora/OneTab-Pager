// launch.mjs — 启动一个独立的 Edge 实例（临时 profile），加载指定解压目录里的扩展。
// 与主人正在运行的 Edge 完全隔离：不同 user-data-dir = 不同实例。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EDGE } from './profile.mjs';
import { CDP, sleep, waitFor } from './cdp.mjs';

/**
 * @param {{profileDir:string, extDir:string, port:number, windowSize?:string, onExit?:Function}} opt
 */
export async function launchEdge({ profileDir, extDir, port, windowSize = '1500,1000', onExit, headless = false }) {
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge: ' + EDGE);
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
  ];
  if (headless) {
    // headless=new：帧由 BeginFrame 主动驱动，不受「窗口被遮挡 -> 合成器停摆」影响。
    // 这是本机唯一能测到真实帧节奏的办法（带窗口时 rAF 被压到 1 帧/秒）。
    args.push('--headless=new', '--hide-scrollbars', `--window-size=${windowSize}`, '--force-device-scale-factor=1');
  } else {
    args.push(
      `--window-size=${windowSize}`,
      '--window-position=40,40',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=msEdgeSidebarV2,msEdgeIdentityFeature,msImplicitSignin,EdgeCollections,CalculateNativeWinOcclusion',
    );
  }
  args.push(
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--no-service-autorun',
    '--password-store=basic',
    'about:blank',
  );
  const child = spawn(EDGE, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (child.exitCode != null) throw new Error('Edge 提前退出：\n' + stderr.slice(-2000));
    const r = await fetch(base + '/json/version').catch(() => null);
    return r && r.ok;
  }, { timeout: 45000, label: 'Edge 调试端口就绪' });

  return {
    base,
    pid: child.pid,
    kill() {
      try { child.kill(); } catch { /* 忽略 */ }
    },
  };
}

/** 连上浏览器级 WebSocket。 */
export async function connectBrowser(base) {
  const v = await (await fetch(base + '/json/version')).json();
  return { cdp: await CDP.connect(v.webSocketDebuggerUrl), version: v };
}

/** 列出所有 target，返回 {id, type, url, title}[] */
export async function listTargets(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos;
}

/**
 * 找出扩展 ID。Edge 自带组件扩展也有 service worker，必须按脚本名精确筛选，
 * 否则会误抓到 background.rollup.js 之类。优先用我们自己的 SW 文件名，其次用期望 ID 直接核验。
 */
export async function findExtensionId(cdp, expectedId) {
  const isOurs = (t) =>
    t.type === 'service_worker' && /ext-onetab-concatenated-sources-background\.js/.test(t.url);

  const ext = await waitFor(async () => {
    const ts = await listTargets(cdp);
    const exact = ts.find((t) => t.type === 'service_worker' &&
      t.url.startsWith('chrome-extension://' + expectedId + '/'));
    return ts.find(isOurs) || exact || null;
  }, { timeout: 30000, interval: 400, label: 'OneTab 扩展 service worker 出现' });

  const id = new URL(ext.url).host;
  if (expectedId && id !== expectedId) {
    throw new Error(`运行时扩展 ID (${id}) 与配置 ID (${expectedId}) 不一致，数据目录会对不上`);
  }
  return { id, via: ext.url };
}

/** 新开一个标签页并附加调试会话。 */
export async function openTarget(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId };
}

export async function closeTarget(cdp, targetId) {
  try { await cdp.send('Target.closeTarget', { targetId }); } catch { /* 忽略 */ }
}

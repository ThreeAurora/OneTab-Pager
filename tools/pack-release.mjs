// pack-release.mjs — 把「OneTab 翻页版」打包成可安装的发布包（zip）。
//
// 为什么需要它：翻页版是「复制商店版 + 加翻页与按需渲染」组装出来的 unpacked 扩展。
// 主人/别人要装，最方便的是直接拿一个 zip 解压后「加载解压缩的扩展」。
//
// 做法：
//   1. 从源目录复制出发布目录（跳过 .git / node_modules / 临时残留）；
//   2. 把 manifest 的版本号改成本次发布版本（2.18.1 → 2.18.1.x 之类的自增位）；
//   3. 写入版本说明文件 VERSION.txt；
//   4. 用 zip 打包（Windows 优先 tar.exe / Compress-Archive 兜底）。
//
// 产出是**正式交付物**，放项目下的 release/<版本>/ 里，不放 cache/tmp。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT = 'E:/CCSpace/projects/2026/09/OneTab性能诊断';
const SRC = path.join(PROJECT, 'OneTab-patched-unpacked');
const VER = process.env.RELEASE_VER || '2.18.1-p1';
const OUT_ROOT = path.join(PROJECT, 'release', 'v' + VER);
const STAGE = path.join(OUT_ROOT, 'OneTab-Pager-' + VER);
const ZIP = path.join(OUT_ROOT, 'OneTab-Pager-' + VER + '.zip');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.vscode', '__MACOSX']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function copyTree(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      copyTree(path.join(src, e.name), path.join(dst, e.name), stats);
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
      stats.files++;
      stats.bytes += fs.statSync(path.join(src, e.name)).size;
    }
  }
}

function main() {
  if (!fs.existsSync(SRC)) throw new Error('源目录不存在: ' + SRC);

  // 清掉上一次的同版本构建（幂等）
  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  const stats = { files: 0, bytes: 0 };
  copyTree(SRC, STAGE, stats);

  // 版本号：manifest 里写成发布版本
  const mfPath = path.join(STAGE, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  const prevVer = mf.version;
  mf.version = VER;
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 3) + '\n');

  // 校验：补丁主体与 CSS 必须都在
  const vjs = path.join(STAGE, 'onetab.virtual.js');
  const css = path.join(STAGE, 'onetab.css');
  if (!fs.existsSync(vjs)) throw new Error('发布包里没有 onetab.virtual.js！');
  if (!fs.existsSync(css)) throw new Error('发布包里没有 onetab.css！');
  const cssTxt = fs.readFileSync(css, 'utf8');
  const marks = ['otvz-pager', 'data-otvz-replica', 'otvzPendingPulse', '--col-bg-color'];
  const missing = marks.filter((m) => !cssTxt.includes(m) && !fs.readFileSync(vjs, 'utf8').includes(m));

  const info = [
    'OneTab 翻页版（OneTab Pager 组装产物）',
    '',
    '版本: ' + VER + '（基于 OneTab ' + prevVer + '）',
    '构建时间: ' + new Date().toISOString(),
    '',
    '包含的改动：',
    '  · 两层虚拟滚动（组层 + 行层）',
    '  · 分页（50/100/200 条每页，选择记忆在 localStorage）',
    '  · 首屏直出（复刻期直接读 IndexedDB 渲染第一页）',
    '  · 复刻期组头按钮「加载中」外观',
    '  · 复刻期预留 288px 侧栏位（对齐官方三栏）',
    '  · 复刻期用 content-visibility 按住官方全量渲染（杜绝首屏卡顿）',
    '',
    '安装：',
    '  1. 解压本目录',
    '  2. edge://extensions（或 chrome://extensions）→ 打开「开发人员模式」',
    '  3. 「加载解压缩的扩展」→ 选择本目录',
    '',
    '注意：翻页版扩展 ID 与商店版不同，数据不共享。',
    '     需要搬运旧数据请见 tools/dump_onetab_items.js 与 tools/backfill_onetab_items.js。',
    '',
    '本包不含 OneTab 源码的修改声明——OneTab 商标与代码版权归其开发者所有。',
  ].join('\n');
  fs.writeFileSync(path.join(STAGE, 'VERSION.txt'), info);

  // 打包：优先 tar.exe（Windows 10+ 自带，能生成 zip）
  const tar = 'C:\\Windows\\System32\\tar.exe';
  let zipped = false;
  if (fs.existsSync(tar)) {
    const r = spawnSync(tar, ['-a', '-c', '-f', ZIP, '-C', OUT_ROOT, path.basename(STAGE)], { encoding: 'utf8' });
    zipped = r.status === 0 && fs.existsSync(ZIP);
    if (!zipped) console.error('tar 打包失败: ' + (r.stderr || r.stdout));
  }
  if (!zipped) {
    const ps = `Compress-Archive -Path '${STAGE}' -DestinationPath '${ZIP}' -Force`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    zipped = r.status === 0 && fs.existsSync(ZIP);
    if (!zipped) console.error('Compress-Archive 失败: ' + (r.stderr || r.stdout));
  }

  const report = {
    version: VER,
    prevManifestVersion: prevVer,
    stage: STAGE,
    zip: ZIP,
    zipBytes: zipped ? fs.statSync(ZIP).size : null,
    files: stats.files,
    bytes: stats.bytes,
    marksChecked: marks,
    marksMissing: missing,
    zipped,
  };
  fs.writeFileSync(path.join(OUT_ROOT, 'pack-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main();

// profile.mjs — 准备一个一次性 Edge 测试 profile，并把它接上主人的真实 OneTab 数据。
//
// 为什么要这么做：实测必须在**真实数据规模**下跑，但又绝不能碰到主人正在用的 profile。
// 做法是把真实 Edge profile 里属于目标扩展的数据目录整体复制进临时 profile，
// 临时 profile 里的扩展 ID 与真身一致（扩展 ID 由「解压目录绝对路径」决定，路径不变 ID 就不变）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

/** 主人真实 Edge profile 根目录 */
export function realUserDataDir() {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error('LOCALAPPDATA 不存在');
  return path.join(local, 'Microsoft', 'Edge', 'User Data');
}

/** 从某个 profile 的 Preferences 里找出「本地加载（location=4）的扩展」的路径 → ID 映射。 */
export function readUnpackedExtensions(userDataDir, profileName = 'Default') {
  const out = [];
  for (const fn of ['Secure Preferences', 'Preferences']) {
    const p = path.join(userDataDir, profileName, fn);
    if (!fs.existsSync(p)) continue;
    let json;
    try { json = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const settings = json?.extensions?.settings || {};
    for (const [id, v] of Object.entries(settings)) {
      if (v?.location === 4 && v?.path) out.push({ id, path: v.path, name: v?.manifest?.name || '' });
    }
  }
  return out;
}

/**
 * 创建/重置临时 profile，并把真实 profile 中该扩展的全部存储目录复制过去。
 * @returns {{profileDir: string, copied: string[]}}
 */
export function prepareProfile({ extId, profileDir, profileName = 'Default' }) {
  const src = realUserDataDir();
  const dst = profileDir;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.join(dst, profileName), { recursive: true });

  const candidates = [
    path.join('IndexedDB', `chrome-extension_${extId}_0.indexeddb.leveldb`),
    path.join('IndexedDB', `chrome-extension_${extId}_0`),
    path.join('Local Extension Settings', extId),
    path.join('Sync Extension Settings', extId),
    path.join('Local Storage', 'leveldb'),
    path.join('Session Storage'),
  ];

  const copied = [];
  for (const rel of candidates) {
    const s = path.join(src, profileName, rel);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dst, profileName, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.cpSync(s, d, { recursive: true, errorOnExist: false, force: true });
    copied.push(rel);
  }

  // 关掉首次运行引导 / 默认浏览器检查 / 崩溃恢复气泡，让启动干净
  fs.writeFileSync(path.join(dst, 'First Run'), '');
  const prefs = path.join(dst, profileName, 'Preferences');
  if (!fs.existsSync(prefs)) {
    fs.writeFileSync(prefs, JSON.stringify({
      profile: { exit_type: 'Normal', exited_cleanly: true },
      browser: { check_default_browser: false, show_home_button: false },
      credentials_enable_service: false,
      extensions: { ui: { developer_mode: true } },
    }));
  }
  return { profileDir: dst, copied };
}

/** 临时工作目录（草稿区，可随时删除；正式交付物不放这里） */
export function labTmpDir(name) {
  const base = process.env.ONETAB_LAB_DIR
    || path.join('E:', path.sep, 'CCSpace', 'cache', 'tmp', 'onetab-lab', name);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

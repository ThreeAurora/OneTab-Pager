// 收尾清理：把本会话草稿移到 cache/tmp 隔离区（可恢复，不硬删）
import { mkdirSync, renameSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'E:/CCSpace/projects/2026/09/OneTab性能诊断';
const SCRATCH = 'E:/CCSpace/cache/tmp/onetab-session-scratch-20260919';
mkdirSync(SCRATCH, { recursive: true });

const files = [
  // tools/lab 下的临时探测脚本
  'OneTab-Pager/tools/lab/sync_check.mjs',
  'OneTab-Pager/tools/lab/state_probe.mjs',
  'OneTab-Pager/tools/lab/find_onetab.mjs',
  'OneTab-Pager/tools/lab/recheck_unp.mjs',
  'OneTab-Pager/tools/lab/probe_unp_state.mjs',
  'OneTab-Pager/tools/lab/poll_unp.mjs',
];
// 项目根的 cache_* 草稿（日志/中间结果）
import { readdirSync } from 'node:fs';
for (const f of readdirSync(ROOT)) {
  if (/^cache_/.test(f)) files.push(f);
}

const moved = [], missing = [];
for (const rel of files) {
  const src = ROOT + '/' + rel;
  if (!existsSync(src)) { missing.push(rel); continue; }
  renameSync(src, SCRATCH + '/' + rel.split('/').pop());
  moved.push(rel.split('/').pop());
}

// 校验保留文件仍在
const keep = {
  virtualJs: existsSync(ROOT + '/OneTab-Pager/onetab.virtual.js'),
  verifyMjs: existsSync(ROOT + '/OneTab-Pager/tools/lab/verify_patch.mjs'),
  doc: existsSync(ROOT + '/OneTab-Pager/docs/虚拟滚动与分页.md'),
  memLog: existsSync(ROOT + '/.workbuddy/memory/2026-09-19.md'),
};
writeFileSync(SCRATCH + '/_moved_manifest.json', JSON.stringify({ moved, missing, keep }, null, 2));
console.log('CLEANUP_DONE moved=' + moved.length);

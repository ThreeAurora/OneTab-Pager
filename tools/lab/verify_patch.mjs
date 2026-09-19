// 权威校验：正确路径下的 unpacked 目录补丁状态
import { statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';

const ROOT = 'E:/CCSpace/projects/2026/09/OneTab性能诊断';
const UNP = ROOT + '/OneTab-patched-unpacked';           // 正确：项目根下的兄弟目录
const P = ROOT + '/OneTab-Performance-Patch';

const out = {};
out.srcJsSize = statSync(P + '/onetab.virtual.js').size;
try {
  out.dstJsSize = statSync(UNP + '/onetab.virtual.js').size;
  const css = readFileSync(UNP + '/onetab.css', 'utf8');
  const html = readFileSync(UNP + '/onetab.html', 'utf8');
  out.css_hasPatch = css.includes('OneTab 不卡补丁');
  out.css_hasPager = css.includes('otvz-pager');
  out.css_hasOffC = css.includes('otvz-off-c');
  out.html_hasTag = html.includes('<script src="onetab.virtual.js">');
  const mf = JSON.parse(readFileSync(UNP + '/manifest.json', 'utf8'));
  out.mfName = mf.name; out.mfVersion = mf.version;
  // JS 内容是否与源一致（分页版）
  out.jsMatchesSrc = readFileSync(UNP + '/onetab.virtual.js').equals(readFileSync(P + '/onetab.virtual.js'));
  // 目录文件数
  let files = 0;
  const cnt = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) cnt(d + '/' + e.name); else files++; } };
  cnt(UNP); out.fileCount = files;
} catch (e) { out.err = e.message; }

writeFileSync(ROOT + '/cache_verify_patch.json', JSON.stringify(out, null, 2));
console.log('VERIFY_DONE');

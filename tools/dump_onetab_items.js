// dump_onetab_items.js —— 在 OneTab 页面（商店版）的 F12 Console 里运行
// 用途：把 OneTab 的 IndexedDB 全部数据（item/attr/shareUpdate）原样导出成 JSON 下载，
//       作为「翻页版」迁移前的安全备份（多少条一条都不能丢）。
// 注意：输出文件包含完整浏览记录，请妥善保管。
(async () => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('onetab');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const out = {};
  for (const name of ['item', 'attr', 'shareUpdate']) {
    if (!db.objectStoreNames.contains(name)) continue;
    const all = await new Promise((res, rej) => {
      const q = db.transaction(name, 'readonly').objectStore(name).getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    out[name] = all;
  }
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'onetab-raw-backup-' + Date.now() + '.json';
  a.click();
  console.log('已导出，各库条数：',
    Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])));
})();
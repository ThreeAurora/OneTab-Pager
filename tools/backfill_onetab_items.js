// backfill_onetab_items.js —— 在「翻页版 OneTab」页面的 F12 Console 里运行
// 前置：把 dump 下载的 JSON 复制进翻页版扩展目录并改名为 onetab-raw-backup.json
// 用途：把导出的 IndexedDB 数据原样写回（item/attr/shareUpdate），刷新后数据全回来。
(async () => {
  const data = await (await fetch('./onetab-raw-backup.json')).json();
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('onetab', 2);
    q.onupgradeneeded = () => {
      const d = q.result;
      if (!d.objectStoreNames.contains('item')) {
        const s = d.createObjectStore('item', { keyPath: 'id' });
        s.createIndex('type', 'type', { unique: false });
        s.createIndex('groupType', 'groupType', { unique: false });
        s.createIndex('task', 'task', { unique: false });
        s.createIndex('parentIds', 'parentIds', { multiEntry: true });
      }
      if (!d.objectStoreNames.contains('attr')) d.createObjectStore('attr');
      if (!d.objectStoreNames.contains('shareUpdate')) d.createObjectStore('shareUpdate');
    };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  let total = 0;
  for (const name of Object.keys(data)) {
    const list = data[name];
    if (!Array.isArray(list) || !list.length) continue;
    const tx = db.transaction(name, 'readwrite');
    const store = tx.objectStore(name);
    for (const rec of list) store.put(rec);
    await new Promise((res, rej) => {
      tx.oncomplete = () => { total += list.length; res(); };
      tx.onerror = () => rej(tx.error);
    });
  }
  console.log('导入完成，共恢复 ' + total + ' 条记录，即将刷新页面…');
  location.reload();
})();
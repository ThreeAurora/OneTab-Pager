// phases.js — 分阶段测量脚本（字符串形式注入页面）。
// 每个阶段是 window.__b.pN() 形式，由 Node 侧逐个调用并施加独立超时，
// 这样任何一段卡死都不会吞掉其它段的结果。

export const PHASES_SOURCE = `
window.__b = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $all = (s) => [...document.querySelectorAll(s)];
  const out = {};

  function scrollerOf(el) {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 10) return n;
    }
    return document.scrollingElement;
  }

  return {
    // p0：等渲染收敛，返回规模与加载期长任务
    async p0() {
      let prev = -1, stable = 0, t0 = performance.now();
      for (let i = 0; i < 90; i++) {
        const n = document.querySelectorAll('.tab').length;
        if (n === prev && n > 0) { stable += 400; if (stable >= 1600) break; } else stable = 0;
        prev = n;
        await sleep(400);
      }
      const settleMs = Math.round(performance.now() - t0);
      await sleep(600);
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        renderedTabs: document.querySelectorAll('.tab').length,
        renderedGroups: document.querySelectorAll('.tabGroup').length,
        nodes: document.getElementsByTagName('*').length,
        settleMs,
        firstRowMs: window.__lab ? Math.round(window.__lab.firstRow) : null,
        loadLongTasks: window.__lab ? window.__lab.longtasks.length : null,
        loadBlockingMs: window.__lab ? Math.round(window.__lab.longtasks.reduce((a, t) => a + t.dur, 0)) : null,
        worstLoadTaskMs: window.__lab ? Math.round(window.__lab.longtasks.reduce((a, t) => Math.max(a, t.dur), 0)) : null,
        nav: nav ? { dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) } : null,
      };
    },

    // p1：结构与行高（补丁设计依据）
    async p1() {
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab' };
      const chain = [];
      for (let el = first; el && chain.length < 9; el = el.parentElement) {
        const cs = getComputedStyle(el);
        chain.push({
          tag: el.tagName, id: el.id || null, cls: String(el.className || '').slice(0, 60),
          kids: el.children.length, overflowY: cs.overflowY, position: cs.position,
          padT: cs.paddingTop, padB: cs.paddingBottom, display: cs.display,
          rectH: Math.round(el.getBoundingClientRect().height),
        });
      }

      // 全量行高（不做抽样——虚拟化必须知道有没有例外）
      const all = $all('.tab');
      const t0 = performance.now();
      const hs = all.map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10);
      const measureAllMs = +(performance.now() - t0).toFixed(1);
      const hist = {};
      for (const h of hs) hist[h] = (hist[h] || 0) + 1;
      const sorted = hs.slice().sort((a, b) => a - b);

      // 行的垂直外边距（若有，则不占 26px 整）
      const cs = getComputedStyle(first);
      const margins = { top: cs.marginTop, bottom: cs.marginBottom };
      const csInner = getComputedStyle(first.firstElementChild || first);

      // 按「直接父元素」给行分组 —— 不依赖 OneTab 的类名，抗更新
      const groups = new Map();
      for (const el of all) {
        const p = el.parentElement;
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push(el);
      }
      const containers = [...groups.entries()].map(([el, rows]) => {
        const c = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          cls: String(el.className || '').slice(0, 40),
          rows: rows.length,
          kids: el.children.length,
          nonRowKids: [...el.children].filter((x) => !x.classList.contains('tab'))
            .map((x) => (x.className || x.tagName) + ':' + Math.round(x.getBoundingClientRect().height)).slice(0, 4),
          padT: c.paddingTop, padB: c.paddingBottom,
          boxH: Math.round(rect.height),
          contentH: el.clientHeight,
          overflow: c.overflow,
        };
      });

      const sc = scrollerOf(first);
      return {
        chainUpFromTab: chain,
        rowHeight: {
          measured: hs.length, measureAllMs, min: sorted[0],
          p50: sorted[Math.floor(sorted.length / 2)],
          max: sorted[sorted.length - 1],
          histogram: Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + 'px×' + v),
          uniform: Object.keys(hist).length === 1,
        },
        margins,
        innerDisplay: csInner.display,
        scroller: { tag: sc.tagName, id: sc.id || null, clientH: sc.clientHeight, scrollH: sc.scrollHeight },
        containerCount: containers.length,
        containers: containers.slice(0, 6),
        containerStats: {
          minRows: Math.min(...containers.map((c) => c.rows)),
          maxRows: Math.max(...containers.map((c) => c.rows)),
          totalRows: containers.reduce((n, c) => n + c.rows, 0),
          withNonRowKids: containers.filter((c) => c.nonRowKids.length).length,
        },
      };
    },

    // p2：命中测试
    async p2() {
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab' };
      const sc = scrollerOf(first);
      const r = sc.getBoundingClientRect();
      const x0 = Math.max(r.left + 8, 1), x1 = Math.min(r.right - 8, innerWidth - 1);
      const y0 = Math.max(r.top + 8, 1), y1 = Math.min(r.bottom - 8, innerHeight - 1);
      const pts = [];
      for (let i = 0; i < 150; i++) pts.push([x0 + Math.random() * (x1 - x0), y0 + Math.random() * (y1 - y0)]);
      for (const [x, y] of pts.slice(0, 25)) document.elementFromPoint(x, y);
      const t0 = performance.now();
      for (const [x, y] of pts) document.elementFromPoint(x, y);
      return { avgMs: +((performance.now() - t0) / pts.length).toFixed(3), samples: pts.length };
    },

    // p3：滚动帧间隔
    async p3() {
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab' };
      const sc = scrollerOf(first);
      const maxScroll = Math.max(0, sc.scrollHeight - sc.clientHeight);
      const gaps = [];
      let last = performance.now(), pos = sc.scrollTop, dir = 1;
      const STEP = 140, DURATION = 5000, started = performance.now();
      await new Promise((resolve) => {
        function tick(now) {
          gaps.push(now - last); last = now;
          if (now - started > DURATION) return resolve();
          pos += STEP * dir;
          if (pos > maxScroll) { pos = maxScroll; dir = -1; }
          if (pos < 0) { pos = 0; dir = 1; }
          sc.scrollTop = pos;
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
        setTimeout(resolve, DURATION + 8000); // 兜底
      });
      const s = gaps.slice(0, -1).sort((a, b) => a - b);
      const q = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0).toFixed(2);
      const res = { frames: s.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +(s[s.length - 1] || 0).toFixed(2),
        longFrames50: s.filter((g) => g > 50).length, overBudget69: s.filter((g) => g > 6.9).length,
        scrollHeight: sc.scrollHeight, scrollTopBefore: sc.scrollTop, scrollTopAfter: sc.scrollTop };
      // rAF 一帧都没跑到 = 窗口被后台节流，数据无效，必须显式标出来
      if (s.length < 10) res.INVALID = 'rAF 基本没触发（窗口被节流），此段数据不可用';
      return res;
    },

    // p2d：命中测试成本的构成拆解
    // 目的：搞清楚剩下这点耗时到底是「布局盒子还太多」还是「一次性布局」。
    async p2d() {
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab' };
      const sc = scrollerOf(first);

      const countBoxes = () => {
        const all = document.getElementsByTagName('*');
        let withBox = 0;
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.getClientRects().length) withBox++;
        }
        return { total: all.length, withBox, noBox: all.length - withBox };
      };

      const hitRound = (n) => {
        const r = sc.getBoundingClientRect();
        const x0 = Math.max(r.left + 8, 1), x1 = Math.min(r.right - 8, innerWidth - 1);
        const y0 = Math.max(r.top + 8, 1), y1 = Math.min(r.bottom - 8, innerHeight - 1);
        const pts = [];
        for (let i = 0; i < n; i++) pts.push([x0 + Math.random() * (x1 - x0), y0 + Math.random() * (y1 - y0)]);
        for (const [x, y] of pts.slice(0, 20)) document.elementFromPoint(x, y);
        const t = performance.now();
        for (const [x, y] of pts) document.elementFromPoint(x, y);
        return +((performance.now() - t) / n).toFixed(3);
      };

      const boxes = countBoxes();
      const rounds = [hitRound(80), hitRound(80), hitRound(80)];

      // 干预 1：把屏幕外的整组（.tabGroup）藏掉，看命中测试降多少
      const vp = sc.getBoundingClientRect();
      const groups = [...document.querySelectorAll('.tabGroup')];
      const hiddenGroups = [];
      for (const g of groups) {
        const b = g.getBoundingClientRect();
        if (b.bottom < vp.top - 400 || b.top > vp.bottom + 400) { hiddenGroups.push([g, g.style.display]); g.style.display = 'none'; }
      }
      sc.getBoundingClientRect();
      const afterHideGroups = hitRound(80);
      const boxes2 = countBoxes();
      for (const [g, d] of hiddenGroups) g.style.display = d;
      sc.getBoundingClientRect();

      return {
        boxes, boxesAfterHidingGroups: boxes2,
        rounds,
        hitAfterHidingOffscreenGroups: afterHideGroups,
        hiddenGroups: hiddenGroups.length, totalGroups: groups.length,
        laidOutRows: window.__otvz ? window.__otvz.laidOutRows : null,
        hiddenRows: window.__otvz ? window.__otvz.hiddenRows : null,
      };
    },

    // p3b：视口移动时主线程必须做的工作量。
    // 不依赖 rAF（本环境 rAF 可能被节流）：每一步滚动后强制同步样式+布局，测出这一步的代价。
    async p3b() {
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab' };
      const sc = scrollerOf(first);
      const maxScroll = Math.max(1, sc.scrollHeight - sc.clientHeight);
      sc.scrollTop = 0;
      void document.documentElement.offsetHeight;   // 预热
      const N = 80, times = [];
      for (let i = 0; i < N; i++) {
        const t = performance.now();
        sc.scrollTop = ((i * 400) % maxScroll);
        void document.documentElement.offsetHeight;  // 强制同步
        times.push(performance.now() - t);
      }
      const s = times.slice(4).sort((a, b) => a - b);
      const q = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0).toFixed(3);
      return { steps: N, perStepP50: q(0.5), perStepP95: q(0.95), perStepMax: +(s[s.length - 1] || 0).toFixed(3),
        totalMs: +times.reduce((a, b) => a + b, 0).toFixed(1) };
    },

    // p4：点击一行 → 打开，测阻塞
    async p4() {
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab' };
      const sc = scrollerOf(first);
      const maxScroll = Math.max(0, sc.scrollHeight - sc.clientHeight);
      sc.scrollTop = Math.floor(maxScroll * 0.5);
      await sleep(600);
      const vp = sc.getBoundingClientRect();
      const rows = $all('.tab');
      const target = rows.find((r) => {
        const b = r.getBoundingClientRect();
        return b.top > vp.top + 20 && b.bottom < vp.bottom - 20 && r.querySelector('a');
      }) || rows.find((r) => r.querySelector('a'));
      if (!target) return { error: '找不到可点的行' };

      const lts = [];
      let obs = null;
      try { obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push(e.duration); }); obs.observe({ entryTypes: ['longtask'] }); } catch (e) {}

      const gaps = [];
      let stop = false, cl = performance.now();
      (function loop(now) { gaps.push(now - cl); cl = now; if (!stop) requestAnimationFrame(loop); })(performance.now());

      const a = target.querySelector('a');
      const link = a.getAttribute('href') || '';
      const t0 = performance.now();
      try { a.click(); } catch (e) { /* 忽略 */ }
      // 把点击后紧接着的重排算进来（用户感觉到的卡顿就发生在这一刻）
      void document.documentElement.offsetHeight;
      const handlerMs = performance.now() - t0;
      await sleep(2000);
      stop = true; if (obs) obs.disconnect();
      const g = gaps.slice(1).sort((x, y) => x - y);
      return { link: link.slice(0, 100), handlerMs: +handlerMs.toFixed(2),
        blockingMs: +lts.reduce((n, d) => n + d, 0).toFixed(1), longTaskCount: lts.length,
        frameMaxMs: +(g[g.length - 1] || 0).toFixed(2) };
    },

    // p5：库内规模（同一扩展同源，可直接读）
    async p5() {
      const db = await new Promise((res) => {
        const q = indexedDB.open('onetab');
        q.onsuccess = () => res(q.result); q.onerror = () => res(null);
        setTimeout(() => res(null), 5000);
      });
      if (!db) return { error: '打不开 onetab 库' };
      const items = await new Promise((res) => {
        const rq = db.transaction(['item'], 'readonly').objectStore('item').getAll();
        rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
        setTimeout(() => res(null), 25000);
      });
      db.close();
      if (!items) return { error: 'getAll 超时' };
      const byType = {};
      let trash = 0;
      for (const it of items) {
        byType[it.type] = (byType[it.type] || 0) + 1;
        if ((it.parentIds || []).includes('trash')) trash++;
      }
      return { total: items.length, byType, inTrash: trash };
    },
    // p6：虚拟滚动补丁自身的状态
    async p6() {
      const v = window.__otvz;
      if (!v) return { present: false, note: '页面里没有 __otvz（补丁未生效）' };
      const rows = document.querySelectorAll('.tab');
      let laidOut = 0;
      for (const r of rows) if (!r.classList.contains('otvz-off')) laidOut++;
      // 视口内实际可见的行（用几何判断，比 class 统计更可信）
      const first = document.querySelector('.tab');
      let visibleInViewport = 0, zeroHeight = 0;
      if (first) {
        const sc = scrollerOf(first);
        const vp = sc.getBoundingClientRect();
        for (const r of rows) {
          const b = r.getBoundingClientRect();
          if (b.height <= 0) { zeroHeight++; continue; }
          if (b.bottom > vp.top && b.top < vp.bottom) visibleInViewport++;
        }
      }
      return {
        present: true, active: v.active, otvzOn: document.documentElement.classList.contains('otvz-on'),
        containers: v.containers, rows: v.rows,
        hiddenInDom: v.hiddenRows, laidOutShown: laidOut,
        hiddenGroups: v.hiddenGroups, domNodes: v.domNodes,
        zeroHeightRows: zeroHeight, visibleInViewport,
        totalRows: rows.length,
        page: v.pageState || null,
        // 翻页条必须在 DOM 里且可见（count=2 = 顶+底）。
        // 曾经翻页条挂载失败（刷新后不出现）而各项指标全绿 —— 必须显式断言。
        pagers: (() => {
          const bars = [...document.querySelectorAll('.otvz-pager')];
          return {
            count: bars.length,
            connected: bars.filter((b) => b.isConnected).length,
            visibleCount: bars.filter((b) => b.style.display !== 'none').length,
          };
        })(),
        stats: v.stats,
      };
    },

    // p10：内部状态转储 —— 「该显示的没显示 / 位置算偏」时看这个
    async p10() {
      const v = window.__otvz;
      if (!v) return { present: false };
      const first = document.querySelector('.tab');
      const sc = scrollerOf(first);
      const before = v.dump(6);
      // 滚到 40% 处再看一次：能区分「模型算错」和「滚动后没重新应用」
      const maxScroll = Math.max(0, sc.scrollHeight - sc.clientHeight);
      sc.scrollTop = Math.floor(maxScroll * 0.4);
      await sleep(800);
      const after = v.dump(6);
      sc.scrollTop = 0;
      await sleep(600);
      return { atTop: before, midScroll: after, restoredTop: v.dump(3) };
    },

    // p8：精度校验 —— 位置模型对不对、虚拟化有没有让滚动条/总高度漂移
    async p8() {
      const v = window.__otvz;
      if (!v) return { present: false, note: '补丁未生效' };
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab' };
      const sc = scrollerOf(first);
      const maxScroll = () => Math.max(0, sc.scrollHeight - sc.clientHeight);

      const g0 = v.geom();
      sc.scrollTop = Math.floor(maxScroll() * 0.5);
      await sleep(700);
      const g1 = v.geom();
      sc.scrollTop = Math.floor(maxScroll() * 0.93);
      await sleep(700);
      const g2 = v.geom();
      sc.scrollTop = 0;
      await sleep(700);
      const g3 = v.geom();
      const check = v.verify ? v.verify(4) : null;
      const g4 = v.geom();
      return {
        geom: { start: g0, half: g1, nearEnd: g2, backTop: g3, afterVerify: g4 },
        scrollHeightDrift: g4.scrollHeight - g0.scrollHeight,
        verify: check,
      };
    },

    // p7：追加 N 行新条目（模拟「发送上百个标签页到 OneTab」）
    // 关心两件事：①追加本身卡多久 ②补丁会不会因此全量重排
    async p7() {
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab' };
      const v = window.__otvz;
      const contBefore = v ? v.stats.remeasured : null;
      const lastRow = [...document.querySelectorAll('.tab')].pop();
      const host = lastRow.parentElement;
      const proto = lastRow.cloneNode(true);

      const lts = [];
      let obs = null;
      try { obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push(e.duration); }); obs.observe({ entryTypes: ['longtask'] }); } catch (e) {}

      const N = 100;
      const t0 = performance.now();
      const frag = document.createDocumentFragment();
      for (let i = 0; i < N; i++) {
        const c = proto.cloneNode(true);
        const a = c.querySelector('a');
        if (a) { a.textContent = 'lab-added-' + i; a.setAttribute('href', 'https://example.com/lab-' + i); }
        frag.appendChild(c);
      }
      host.appendChild(frag);
      // 关键：append 本身很便宜，用户真正感觉到的是「随后的重排」。
      // 这里强制一次同步布局，把这一刀算进来 —— 否则两边的数字都会好看得没有意义。
      void document.documentElement.offsetHeight;
      const insertMs = performance.now() - t0;

      await sleep(2000);
      if (obs) obs.disconnect();
      const contAfter = v ? v.stats.remeasured : null;
      return {
        inserted: N,
        insertMs: +insertMs.toFixed(1),
        blockingMs: +lts.reduce((a, b) => a + b, 0).toFixed(1),
        longTaskCount: lts.length,
        worstTaskMs: +lts.reduce((a, b) => Math.max(a, b), 0).toFixed(1),
        domNodes: document.getElementsByTagName('*').length,
        rowsAfter: document.querySelectorAll('.tab').length,
        remeasuredDelta: (contBefore != null && contAfter != null) ? contAfter - contBefore : null,
        syncs: v ? v.stats.syncs : null,
        lastSyncMs: v ? v.stats.lastSyncMs : null,
        visibleAfter: (() => {
          const sc = scrollerOf(document.querySelector('.tab'));
          const vp = sc.getBoundingClientRect();
          let n = 0;
          for (const r of document.querySelectorAll('.tab')) {
            const b = r.getBoundingClientRect();
            if (b.height > 0 && b.bottom > vp.top && b.top < vp.bottom) n++;
          }
          return n;
        })(),
      };
    },
    // p11：官方状态下（p9 已经 kill 掉补丁）做同样两个动作，作为对照基线。
    //   ① 点开一条  ② 追加 100 行
    // 必须排在 p9 之后跑，否则拿不到「官方原状」这个对照组。
    async p11() {
      const patched = !!(window.__otvz && window.__otvz.active);
      const first = document.querySelector('.tab');
      if (!first) return { error: '没有 .tab', patched };
      const sc = scrollerOf(first);
      const out = { patched, note: patched ? '补丁仍在生效，这组不是基线' : '官方原状' };

      // ---- ① 点开一条 ----
      (() => {
        const rows = $all('.tab');
        const vp = sc.getBoundingClientRect();
        const target = rows.find((r) => {
          const b = r.getBoundingClientRect();
          return b.top > vp.top + 20 && b.bottom < vp.bottom - 20 && r.querySelector('a');
        }) || rows.find((r) => r.querySelector('a'));
        if (!target) { out.click = { error: '找不到可点的行' }; return; }
        const lts = [];
        let obs = null;
        try { obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) lts.push(e.duration); }); obs.observe({ entryTypes: ['longtask'] }); } catch (e) {}
        const a = target.querySelector('a');
        const t0 = performance.now();
        try { a.click(); } catch (e) { /* 忽略 */ }
        // 同样地，把「点击后紧接着的重排」算进来
        void document.documentElement.offsetHeight;
        out.click = {
          handlerMs: +(performance.now() - t0).toFixed(2),
          blockingMs: +lts.reduce((x, y) => x + y, 0).toFixed(1),
          longTaskCount: lts.length,
          link: (a.getAttribute('href') || '').slice(0, 60),
        };
        setTimeout(() => { if (obs) obs.disconnect(); }, 1200);
      })();

      await sleep(1500);

      // ---- ② 追加 100 行 ----
      const lastRow = [...document.querySelectorAll('.tab')].pop();
      if (!lastRow) { out.insert = { error: '没有 .tab' }; return out; }
      const host = lastRow.parentElement;
      const proto = lastRow.cloneNode(true);
      const lts2 = [];
      let obs2 = null;
      try { obs2 = new PerformanceObserver((l) => { for (const e of l.getEntries()) lts2.push(e.duration); }); obs2.observe({ entryTypes: ['longtask'] }); } catch (e) {}

      const N = 100;
      const t0 = performance.now();
      const frag = document.createDocumentFragment();
      for (let i = 0; i < N; i++) {
        const c = proto.cloneNode(true);
        const a = c.querySelector('a');
        if (a) { a.textContent = 'official-lab-' + i; a.setAttribute('href', 'https://example.com/off-' + i); }
        frag.appendChild(c);
      }
      host.appendChild(frag);
      void document.documentElement.offsetHeight;   // 含重排，才和补丁那边可比
      const insertMs = performance.now() - t0;
      await sleep(2000);
      if (obs2) obs2.disconnect();
      out.insert = {
        inserted: N,
        insertMs: +insertMs.toFixed(1),
        blockingMs: +lts2.reduce((x, y) => x + y, 0).toFixed(1),
        longTaskCount: lts2.length,
        worstTaskMs: +lts2.reduce((x, y) => Math.max(x, y), 0).toFixed(1),
        rowsAfter: document.querySelectorAll('.tab').length,
        domNodes: document.getElementsByTagName('*').length,
      };
      return out;
    },

    // p12：分页功能测试（必须在补丁存活时跑，别放在 p9 之后）
    //   ① 翻到第 2 页（触发「整容器隐藏 → 进页全量重刷」路径）
    //   ② 跳最后一页（不满一页的边界：5206 条 ÷ 100 = 53 页余 6 条）
    //   ③ 每页 50 / 恢复 100（localStorage 记忆 + 页数重算）
    async p12() {
      const v = window.__otvz;
      if (!v || !v.pageState) return { present: false, note: '补丁未生效' };
      if (!v.pageState.on) return { present: true, note: '分页未启用（总行数在一页以内）' };
      const out = { steps: [] };
      // 全文档里「真实占高度」的行数 —— 分页模式下应 ≈ 当前页条数
      const visRows = () => {
        let n = 0;
        for (const r of document.querySelectorAll('.tab')) {
          if (r.getBoundingClientRect().height > 0) n++;
        }
        return n;
      };
      out.steps.push({ at: '初始', ...v.pageState, visibleRows: visRows(),
        pagers: document.querySelectorAll('.otvz-pager').length });

      v.setPage(1);                       // 第 2 页
      await sleep(400);
      out.steps.push({ at: '第2页', ...v.pageState, visibleRows: visRows(), scrollTop: v.geom().scrollTop });
      if (out.steps[1].visibleRows < 1) out.page2Empty = '⚠️ 第2页一行都没显示';

      v.setPage(v.pageState.pages - 1);   // 最后一页
      await sleep(400);
      out.steps.push({ at: '最后一页', ...v.pageState, visibleRows: visRows() });

      v.setPage(0);                       // 回第 1 页 + 改每页条数
      v.setPageSize(50);
      await sleep(400);
      out.steps.push({ at: '每页50', ...v.pageState, visibleRows: visRows() });

      v.setPageSize(100);
      await sleep(400);
      out.steps.push({ at: '恢复100', ...v.pageState, visibleRows: visRows() });

      out.verify = v.verify ? v.verify(2) : null;
      out.geom = v.geom();
      return out;
    },
  };
})();
'ok';
`;

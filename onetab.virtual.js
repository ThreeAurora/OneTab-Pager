/* ============================================================================
 * OneTab 真虚拟滚动补丁  onetab.virtual.js
 * ----------------------------------------------------------------------------
 * 解决的问题
 *   官方 OneTab 把「全部条目」一次性放进 DOM。实测 5207 行 = 56132 个节点，
 *   其中五千多个盒子参与布局，document.elementFromPoint 单次要 4~6 ms，
 *   而 144 Hz 一帧只有 6.9 ms —— 于是鼠标一动就掉帧、滚动发涩、点击后整页僵住。
 *
 * 为什么之前那行 CSS 不够
 *   content-visibility: auto 只让屏幕外元素跳过绘制，父容器该遍历的盒子一个没少
 *   （实测只降 44%）。必须让「参与布局的子盒子数」与总条目数解耦。
 *
 * 做法：两层虚拟化
 *   第一层：屏幕外的整组（.tabGroup）摘掉 —— 这是大头。
 *   第二层：屏幕外的条目（.tab）摘掉。
 *   两层都用「宿主容器的 padding 顶住被摘掉的高度」，
 *   于是滚动条长度、滚动位置、可见内容的像素位置分毫不动。
 *
 * 高度模型（这一版的核心，也是最容易搞错的地方）
 *   容器的总高不是一个数字，而是一条恒等式：
 *
 *     高度 = 边框 + 基准padding + 首元素外边距 + 内容跨度 + extra
 *              └────────────── 常数，量一次就不再变 ──────────────┘
 *
 *   其中「内容跨度」= Σ(每个子元素的高度 + 它与上一个的间距)，全部按元素缓存。
 *   于是：
 *     · 新增 100 行  → 只量这 100 行，跨度重算，高度自动跟上（不必展开任何东西）
 *     · 滚动 / 点击  → 完全不碰测量
 *     · extra 只在容器「原状」时量一次，量完就是常数，永远不再被动态 padding 污染
 *
 *   踩过的坑：早先版本用「容器当前实测高度 − 基准padding − 内容跨度」反推 extra，
 *   而「当前高度」可能包含我们自己写进去的动态 padding，也可能是页面还没渲染完的
 *   半成品高度。结果把 151064px 的列表撑成 227674px，滚动条直接长了一半。
 *
 * 安全性
 *   只做两件事：给元素加/去一个 class、给容器写 paddingTop/paddingBottom。
 *   从不删节点、不改结构、不碰官方状态；任何一步出错都会整体回滚。
 *   显示永远靠「不写这个 class」，所以官方自己的筛选/折叠逻辑不会被覆盖。
 *
 * 调试接口（window.__otvz）
 *   geom()   滚动容器几何量（判断总高度有没有漂）
 *   verify() 精度自检：虚拟化下 vs 恢复原状后的总高度、逐行位置误差
 *   dump()   内部状态转储，排查「该显示的没显示 / 位置算偏」
 *   kill()   永久停用本页补丁，用于同页 A/B 对照
 * ==========================================================================*/
(function () {
  'use strict';

  var CLS_ROW = 'otvz-off';    // 行：display:none !important
  var CLS_GRP = 'otvz-off-g';  // 分组：display:none !important
  var CLS_BOX = 'otvz-off-c';  // 行容器：分页时整段没有本页条目，连容器一起藏
  var ROW_MARGIN = 320;        // 行层视口上下缓冲（像素）
  var GRP_MARGIN = 1400;       // 组层缓冲：留大些，避免打断「跳转到某分组」
  var SETTLE_MS = 250;         // 结构变动静默期
  var MIN_ROWS = 60;
  var MIN_GROUPS = 8;
  var PAGE_INLINE_MAX = 400;   // 单页超过这个行数才启用页内视口收缩（100/200 条/页根本用不到）
  var PAGE_SIZE_KEY = 'otvzPageSize';

  var scroller = null;
  var L = null;                 // 组层容器
  var conts = [];               // 行层容器
  var contsByEl = new Map();
  var groupIndex = new Map();   // .tabGroup 元素 -> 在 L 里的下标
  var active = false, built = false, killed = false;
  var lastTop = -1, lastVH = -1;
  var rafId = 0, settleT = 0, retryT = 0;
  var forceFull = false;
  var stats = { syncs: 0, applies: 0, measured: 0, lastSyncMs: 0, maxSyncMs: 0, hidRows: 0, hidGroups: 0 };

  // ---------- 分页状态 ----------
  // 页的切片按「官方可见行」计数：官方搜索/筛选藏掉的行（高度 0）不占名额，
  // 于是搜索结果会被自然分页，搜索功能不受影响。
  var page = {
    on: false,          // 分页是否启用（总可见行数 > 一页时为 true；决定渲染走分页路径还是视口路径）
    size: 100,          // 每页条数（50/100/200，localStorage 记忆）
    idx: 0,             // 当前页（从 0 计）
    start: 0, end: 0,   // 当前页的可见行序号区间 [start, end)
    total: 0,           // 官方可见行总数
    pages: 0,           // 总页数
    bars: null,         // [顶部翻页条, 底部翻页条]
    early: false,       // boot 即挂的「先遣翻页条」还在临时位置（#contentAreaDiv），
                        // 显示「加载中…」；列表渲染出来后 sync 会把条迁到正式位置并清掉此标记
    loading: false,     // 官方仍在渲染（DOM 行数还在涨）。加载中即使行数不足一页也显示翻页条，
                        // 否则大数据用户刷新后要干等官方渲染完（实测 6~8 秒）才能见到翻页条
    lastRows: -1        // 上次 sync 看到的 DOM 行数（loading 判断用）
  };

  // 按元素缓存几何：换了容器对象也不丢，于是「只有新元素才需要量」
  var hCache = new WeakMap();      // 子元素 -> 高度
  var gapCache = new WeakMap();    // 子元素 -> 与上一元素的间距
  var baseCache = new WeakMap();   // 容器元素 -> {padT,padB,brdT,brdB,indent,extra}

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function qsa(sel, root) {
    var list = (root || document).querySelectorAll(sel);
    // 首屏直出（replica）在场期间，复刻子树里的 .tab/.tabGroup 不是官方内容，
    // 绝不能进统计与测量（否则行数虚高、findScroller 认错滚动容器）。
    if (!rpActive()) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i], skip = false;
      while (n && n !== document.body) {
        if (n.getAttribute && n.getAttribute('data-otvz-replica')) { skip = true; break; }
        n = n.parentElement;
      }
      if (!skip) out.push(list[i]);
    }
    return out;
  }
  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // ---------- 滚动容器 ----------
  function findScroller() {
    var rows = qsa('.tab');
    if (!rows.length) return null;
    for (var n = rows[0].parentElement; n; n = n.parentElement) {
      var cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
    }
    return document.scrollingElement || document.documentElement;
  }
  function useScroller(el) {
    if (scroller === el) return;
    if (scroller) scroller.removeEventListener('scroll', onScroll);
    scroller = el;
    if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---------- 容器模型 ----------
  function makeContainer(el, items, cls, prev) {
    var n = items.length;
    var sameN = !!(prev && prev.n === n);
    var c = {
      el: el, items: items, cls: cls, n: n,
      h: null, gap: null, off: null,
      span: 0, defaultGap: 0, extra: 0, indent: 0, naturalH: 0,
      padT: 0, padB: 0, brdT: 0, brdB: 0,
      top: null, relTop: null, gi: -1,
      known: 0,
      // 行数变了就意味着上一轮留在 DOM 上的隐藏 class 不能再按旧区间推断。
      // 注意 prev 为空时（首次）不算变化 —— 那时我们还没往 DOM 上写过任何东西。
      nChanging: !!(prev && prev.n !== n),
      p0: sameN ? prev.p0 : 0, p1: sameN ? prev.p1 : n - 1
    };
    if (prev) { c.relTop = prev.relTop; c.top = prev.top; }
    applyBase(c);
    computeSpan(c);
    return c;
  }

  function applyBase(c) {
    var b = baseCache.get(c.el);
    if (!b) { c.padT = 0; c.padB = 0; c.brdT = 0; c.brdB = 0; c.indent = 0; c.extra = 0; return false; }
    c.padT = b.padT; c.padB = b.padB; c.brdT = b.brdT; c.brdB = b.brdB;
    c.indent = b.indent; c.extra = b.extra;
    return true;
  }

  // 内容跨度：Σ(高度 + 间距)。纯算术，不触发布局。
  function computeSpan(c) {
    var n = c.n, i;
    var h = new Float64Array(n), gap = new Float64Array(n), off = new Float64Array(n);
    var known = 0, gapSum = 0, gapN = 0;
    for (i = 0; i < n; i++) {
      var hv = hCache.get(c.items[i]);
      if (hv == null) hv = 0; else known++;
      h[i] = hv;
      var gv = (i === 0) ? 0 : gapCache.get(c.items[i]);
      if (gv == null) gv = NaN;
      else if (i > 0) { gapSum += gv; gapN++; }
      gap[i] = gv;
    }
    c.defaultGap = gapN ? gapSum / gapN : 0;
    var acc = 0, span = 0;
    for (i = 0; i < n; i++) {
      off[i] = acc;
      var gp = isFinite(gap[i]) ? gap[i] : c.defaultGap;
      span = acc + h[i];
      acc += h[i] + gp;
    }
    c.h = h; c.gap = gap; c.off = off;
    c.span = span; c.known = known;
    c.naturalH = c.brdT + c.brdB + c.padT + c.padB + c.indent + c.span + c.extra;
    return known === n;
  }

  function collect() {
    // 行层：按「直接父元素」给 .tab 分组，不依赖 OneTab 的类名，抗更新
    var rows = qsa('.tab');
    var map = new Map(), order = [];
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i].parentElement;
      if (!p) continue;
      var g = map.get(p);
      if (!g) { g = { el: p, items: [] }; map.set(p, g); order.push(g); }
      g.items.push(rows[i]);
    }
    var next = [], nextByEl = new Map();
    for (var k = 0; k < order.length; k++) {
      var c = makeContainer(order[k].el, order[k].items, CLS_ROW, contsByEl.get(order[k].el));
      next.push(c); nextByEl.set(c.el, c);
    }
    conts = next; contsByEl = nextByEl;

    // 组层：选「装着最多分组」的那个父元素
    var prevL = L;                 // 必须先存下来：下面会把 L 置空
    var grps = qsa('.tabGroup');
    L = null;
    groupIndex.clear();
    if (grps.length >= MIN_GROUPS) {
      var pm = new Map();
      for (var j = 0; j < grps.length; j++) {
        var par = grps[j].parentElement;
        if (!par) continue;
        var e = pm.get(par); if (!e) { e = { el: par, items: [] }; pm.set(par, e); }
        e.items.push(grps[j]);
      }
      var best = null;
      pm.forEach(function (e) { if (!best || e.items.length > best.items.length) best = e; });
      if (best && best.items.length >= MIN_GROUPS) {
        L = makeContainer(best.el, best.items, CLS_GRP, prevL);
        for (var m = 0; m < L.n; m++) groupIndex.set(L.items[m], m);
      }
    }
  }

  function linkRowContainersToGroups() {
    for (var k = 0; k < conts.length; k++) {
      var c = conts[k], gi = -1;
      if (L) {
        for (var n = c.el.parentElement; n; n = n.parentElement) {
          if (groupIndex.has(n)) { gi = groupIndex.get(n); break; }
          if (n === L.el) break;
        }
      }
      c.gi = gi;
    }
  }

  // ---------- 恢复原状 ----------
  // styleDirty 用来判断「这次到底动过样式没有」：
  // 没动过就不需要强制布局，读 getBoundingClientRect() 是纯读的，快得多。
  var styleDirty = false;

  function release(c) {
    if (!c) return;
    if (c.p0 !== 0 || c.p1 !== c.n - 1 || c.nChanging) styleDirty = true;
    for (var i = 0; i < c.n; i++) c.items[i].classList.remove(c.cls);
    // 基准还没量到之前绝对不能写 padding：那时 padT 是占位用的 0，
    // 写下去会覆盖官方原本的 padding（.childContainer 是 4px/12px），把测量污染掉。
    if (baseCache.has(c.el)) {
      var pt = c.padT + 'px', pb = c.padB + 'px';
      if (c.el.style.paddingTop !== pt || c.el.style.paddingBottom !== pb) styleDirty = true;
      c.el.style.paddingTop = pt;
      c.el.style.paddingBottom = pb;
    }
    c.p0 = 0; c.p1 = c.n - 1;
    c.nChanging = false;
  }
  function unhideAll() {
    if (L) release(L);
    for (var k = 0; k < conts.length; k++) {
      conts[k].el.classList.remove(CLS_BOX);
      release(conts[k]);
    }
  }

  // ---------- 测量 ----------
  // 只有「缓存里没有高度」的元素才需要量；只有「还没量过基准」的容器才需要量基准。
  // 全量路径（首次 / 窗口尺寸变化）会清空缓存并整体恢复原状；
  // 增量路径只把「新元素所在的组」放出来，绝不动其它分支。
  function measure(full) {
    if (full) {
      hCache = new WeakMap(); gapCache = new WeakMap(); baseCache = new WeakMap();
      forceFull = false;
    }
    styleDirty = false;

    var items = [], bases = [], k, i;
    if (L) {
      if (!baseCache.has(L.el)) bases.push(L);
      for (i = 0; i < L.n; i++) if (hCache.get(L.items[i]) == null) items.push(L.items[i]);
    }
    for (k = 0; k < conts.length; k++) {
      var c = conts[k];
      if (!baseCache.has(c.el)) bases.push(c);
      for (i = 0; i < c.n; i++) if (hCache.get(c.items[i]) == null) items.push(c.items[i]);
    }
    if (!items.length && !bases.length) return false;

    if (full) {
      if (built) unhideAll();          // 从没启用过就没藏过东西，不必恢复（也省掉一次布局）
    } else {
      // 只放出「需要测量的元素/容器」所在的分组，其余保持不动
      var open = new Set();
      for (k = 0; k < bases.length; k++) if (bases[k].gi >= 0) open.add(bases[k].gi);
      for (k = 0; k < items.length; k++) {
        var gEl = items[k].closest ? items[k].closest('.' + CLS_GRP) : null;
        if (gEl) { var gi = groupIndex.get(gEl); if (gi != null && gi >= 0) open.add(gi); }
      }
      if (L) {
        for (k = 0; k < bases.length; k++) {
          // L 的基准必须整体原状才能量准 —— 一旦走到这一步就退化为全量
          if (bases[k] === L) { unhideAll(); full = true; break; }
        }
      }
      if (!full) {
        open.forEach(function (gi) {
          if (!L || !L.items[gi]) return;
          L.items[gi].classList.remove(CLS_GRP);
          // 组内每个行容器也要恢复原状，否则组的高度量不准
          for (var q = 0; q < conts.length; q++) if (conts[q].gi === gi) release(conts[q]);
        });
        for (k = 0; k < bases.length; k++) release(bases[k]);
      }
    }

    var t0 = now();
    // 只有真的动过样式才值得强制一次布局。
    // 首次同步恰好是「没动过」的情形：我们还没写过任何 class 和 padding，
    // 页面本来就是原状，此时读几何量是纯读 —— 不该替官方付那次完整布局的钱
    // （实测那一刀要 600ms 以上，而纯读全量只要几十毫秒）。
    if (styleDirty) { void scroller.offsetHeight; styleDirty = false; }

    // 1+2) 单遍测量：每个元素只读一次 rect，同时拿到高度与「与上一元素的间距」。
    // 旧实现分两遍（先高度后间距），间距那遍把所有 rect 重读了一遍 —— 纯浪费一倍。
    // 可见性语义：height<=0 的元素（官方隐藏 / 整组被摘）不缓存高度，并打断间距链。
    function measureChain(c) {
      var prevB = null;
      for (var i = 0; i < c.n; i++) {
        var el = c.items[i];
        var r = el.getBoundingClientRect();
        if (r.height <= 0) { prevB = null; continue; }
        if (hCache.get(el) == null) hCache.set(el, r.height);
        if (prevB != null && gapCache.get(el) == null) gapCache.set(el, Math.max(0, r.top - prevB));
        prevB = r.bottom;
      }
    }
    if (L) measureChain(L);
    for (k = 0; k < conts.length; k++) measureChain(conts[k]);
    // 3) 内容跨度（纯算术）
    if (L) computeSpan(L);
    for (k = 0; k < conts.length; k++) computeSpan(conts[k]);

    // 4) 容器基准 + extra（此时容器已恢复原状，box.height 是干净的真实高度）
    var contentTop = scroller.getBoundingClientRect().top - scroller.scrollTop;
    for (k = 0; k < bases.length; k++) {
      var b = bases[k], el = b.el, box = el.getBoundingClientRect();
      if (box.height <= 0) continue;
      var cs = getComputedStyle(el);
      var padT = px(cs.paddingTop), padB = px(cs.paddingBottom);
      var brdT = px(cs.borderTopWidth), brdB = px(cs.borderBottomWidth);
      var indent = b.n ? px(getComputedStyle(b.items[0]).marginTop) : 0;
      var extra = box.height - brdT - brdB - padT - padB - indent - b.span;
      baseCache.set(el, { padT: padT, padB: padB, brdT: brdT, brdB: brdB, indent: indent, extra: extra });
      applyBase(b);
      computeSpan(b);                       // extra 变了 -> naturalH 变了
      if (b.top == null) b.top = box.top - contentTop;
    }
    // L 的位置也顺手刷新一次（它上面可能有别的东西变了）
    if (L && baseCache.has(L.el)) L.top = L.el.getBoundingClientRect().top - contentTop;

    // 5) 行容器的位置：可见的直接实测；被组层摘掉的用「组偏移 + 相对偏移」推
    var lContentTop = (L && L.top != null) ? (L.top + L.brdT + L.padT) : 0;
    for (k = 0; k < conts.length; k++) {
      var c2 = conts[k];
      var cr = c2.el.getBoundingClientRect();
      if (cr.height > 0) {
        var realTop = cr.top - contentTop;
        if (L && c2.gi >= 0) c2.relTop = realTop - (lContentTop + L.off[c2.gi]);
        c2.top = realTop;
      } else if (L && c2.gi >= 0) {
        if (c2.relTop == null) c2.relTop = 0;
        c2.top = lContentTop + L.off[c2.gi] + c2.relTop;
      } else if (c2.top == null) {
        c2.top = 0;
      }
    }

    stats.measured += items.length;
    if (full) stats.lastFullMs = Math.round(now() - t0);
    forceFull = false;                      // 缓存已补齐，不再需要强制全量
    return true;
  }

  // ---------- 分页：切页 ----------
  // vbase：容器第一个可见行的全局可见序号；vcount：容器内可见行数；
  // pi0/pi1：本页条目在容器里的下标区间（-1 表示本容器没有本页条目）。
  // 切片只数「官方可见」的行（高度 0 的行不占名额），所以官方搜索/筛选
  // 藏掉多少行都不影响页的完整性 —— 搜索结果会被自然分页。
  function computePages() {
    var size = page.size, gv = 0, k, i;
    var byGroup = L ? new Array(L.n) : null;
    for (k = 0; k < conts.length; k++) {
      var c = conts[k];
      c.vbase = gv;
      var vc = 0;
      for (i = 0; i < c.n; i++) if (c.h[i] > 0) vc++;
      c.vcount = vc;
      gv += vc;
      if (byGroup && c.gi >= 0 && c.gi < byGroup.length) {
        (byGroup[c.gi] || (byGroup[c.gi] = [])).push(c);
      }
    }
    page.total = gv;
    page.pages = Math.max(1, Math.ceil(gv / size));
    if (page.idx >= page.pages) page.idx = page.pages - 1;
    if (page.idx < 0) page.idx = 0;
    page.start = page.idx * size;
    page.end = Math.min(gv, page.start + size);
    // 没有组层容器（分组太少 < MIN_GROUPS）就没有翻页条的挂载点，
    // 此时退回视口模式 —— 视口虚拟滚动对这种规模本来就够快
    page.on = gv > size && !!L;

    // 从分页切回视口模式（如删除大量条目后总行数 ≤ 一页）时，
    // 清掉分页遗留的容器隐藏 class，视口路径会重新接管显示
    if (!page.on) {
      for (k = 0; k < conts.length; k++) conts[k].el.classList.remove(CLS_BOX);
    }

    for (k = 0; k < conts.length; k++) {
      var c2 = conts[k], s = page.start, e = page.end, kk = c2.vbase, pi0 = -1, pi1 = -2;
      for (i = 0; i < c2.n; i++) {
        if (c2.h[i] <= 0) continue;
        if (kk >= s && kk < e) { if (pi0 < 0) pi0 = i; pi1 = i; }
        kk++;
      }
      c2.pi0 = pi0; c2.pi1 = pi1;
    }
    if (L) {
      L.piFlags = new Uint8Array(L.n);
      for (i = 0; i < L.n; i++) {
        var arr = byGroup[i], hit = 0;
        if (arr) for (k = 0; k < arr.length; k++) if (arr[k].pi0 >= 0) { hit = 1; break; }
        L.piFlags[i] = hit;
      }
    }
  }

  // 分页模式下的容器窗口应用。窗口 = 本页条目区间 [pi0, pi1]，窗口外全藏。
  // fullSweep：容器此前被「整容器隐藏」过时，行 class 的旧状态不可信，必须逐行重刷；
  // 否则按新旧窗口差量增删。
  function applyWindowPage(c, fullSweep) {
    var i0 = c.pi0, i1 = c.pi1, i;
    if (fullSweep) {
      for (i = 0; i < c.n; i++) {
        if (i < i0 || i > i1) c.items[i].classList.add(c.cls);
        else c.items[i].classList.remove(c.cls);
      }
    } else {
      for (i = c.p0; i <= c.p1; i++) {
        if (i < i0 || i > i1) c.items[i].classList.add(c.cls);
      }
      for (i = i0; i <= i1; i++) {
        if (i < c.p0 || i > c.p1) c.items[i].classList.remove(c.cls);
      }
    }
    // 页内补高：窗口就是本页条目区间本身，窗口内没有要补的高度；
    // 公式保留通用形式（i0=pi0、i1=pi1 时结果恰好等于基准 padding），
    // 这样将来若引入「页内视口收缩」（PAGE_INLINE_MAX）无需改这里。
    var pt = c.padT + (c.off[i0] - c.off[c.pi0]);
    var pb = c.padB + ((c.off[c.pi1] + c.h[c.pi1]) - (c.off[i1] + c.h[i1]));
    c.el.style.paddingTop = pt + 'px';
    c.el.style.paddingBottom = pb + 'px';
    c.p0 = i0; c.p1 = i1;
  }

  // ---------- 分页：应用 ----------
  function applyPage() {
    var k, i;
    for (k = 0; k < conts.length; k++) {
      var c = conts[k];
      if (c.pi0 < 0) {
        // 本容器没有本页条目：只藏容器本身。display:none 子树不参与样式重算，
        // 比给几千行逐个加 class 便宜一个量级；行上的旧 class 留着无害
        // （整棵子树不可见），等它重新进页时由 applyWindowPage 全量重刷。
        if (!c.el.classList.contains(CLS_BOX)) c.el.classList.add(CLS_BOX);
        c.p0 = 1; c.p1 = 0;
        c.el.style.paddingTop = c.padT + 'px';
        c.el.style.paddingBottom = c.padB + 'px';
        continue;
      }
      // 进页容器：此前若被整容器藏过，先摘掉容器隐藏，再全量重刷行 class
      var wasBoxed = c.el.classList.contains(CLS_BOX);
      if (wasBoxed) c.el.classList.remove(CLS_BOX);
      applyWindowPage(c, wasBoxed);
    }
    if (L) {
      for (i = 0; i < L.n; i++) {
        var g = L.items[i];
        var hide = !L.piFlags[i];
        var isHid = g.classList.contains(CLS_GRP);
        if (hide && !isHid) { g.classList.add(CLS_GRP); stats.hidGroups++; }
        else if (!hide && isHid) g.classList.remove(CLS_GRP);
      }
      // 组层容器本身不补高：页外的组不占滚动条
      L.el.style.paddingTop = L.padT + 'px';
      L.el.style.paddingBottom = L.padB + 'px';
    }
    updatePagers();
  }

  // 目标元素（一行）的全局可见序号，翻页跳转用
  function globalIndexOf(el) {
    var par = el.parentElement;
    for (var k = 0; k < conts.length; k++) {
      var c = conts[k];
      if (c.el !== par) continue;
      var i = c.items.indexOf(el);
      if (i < 0) return null;
      var vis = 0;
      for (var j = 0; j < i; j++) if (c.h[j] > 0) vis++;
      return c.vbase + vis;
    }
    return null;
  }

  // ---------- 翻页条 ----------
  function buildPager() {
    var bar = document.createElement('div');
    bar.className = 'otvz-pager';
    var prev = document.createElement('button');
    prev.textContent = '‹ 上一页';
    var info = document.createElement('span');
    info.className = 'otvz-pager-info';
    var next = document.createElement('button');
    next.textContent = '下一页 ›';
    var label = document.createElement('span');
    label.className = 'otvz-pager-label';
    label.textContent = '每页';
    var sel = document.createElement('select');
    [50, 100, 200].forEach(function (n) {
      var o = document.createElement('option');
      o.value = String(n);
      o.textContent = n + ' 条';
      sel.appendChild(o);
    });
    sel.value = String(page.size);
    prev.addEventListener('click', function () { setPage(page.idx - 1); });
    next.addEventListener('click', function () { setPage(page.idx + 1); });
    sel.addEventListener('change', function () {
      var v = parseInt(sel.value, 10);
      if (v === 50 || v === 100 || v === 200) setPageSize(v);
    });
    bar.appendChild(prev);
    bar.appendChild(info);
    bar.appendChild(next);
    bar.appendChild(label);
    bar.appendChild(sel);
    return { bar: bar, prev: prev, next: next, info: info, sel: sel };
  }

  // 翻页条插在列表容器的**外面**（前后兄弟位置），完全不进定位模型
  function mountPagers() {
    if (!L || !L.el || !L.el.parentNode) return;
    if (!page.bars) page.bars = [buildPager(), buildPager()];
    page.bars[0].bar.classList.add('otvz-pager-top');   // 顶栏用更紧凑的间距变体
    var p = L.el.parentNode;
    // 顶部条必须紧贴列表容器之前（先遣条可能挂在 #contentAreaDiv 顶部，要迁到正式位置）
    if (page.bars[0].bar.parentNode !== p || page.bars[0].bar.nextSibling !== L.el) {
      p.insertBefore(page.bars[0].bar, L.el);
    }
    if (page.bars[1].bar.parentNode !== p || page.bars[1].bar.previousSibling !== L.el) {
      if (L.el.nextSibling) p.insertBefore(page.bars[1].bar, L.el.nextSibling);
      else p.appendChild(page.bars[1].bar);
    }
    page.early = false;   // 条已就位，此后显示由 page.on / page.loading 决定
  }

  // 先遣翻页条：boot 时列表还没渲染（官方要从存储读几 MB 数据再建 5000+ 行），
  // 为了让「分页」第一时间可见，把条先挂进静态壳 #contentAreaDiv 显示「加载中…」。
  // 列表渲染出来后 mountPagers 会把条迁到正式位置；小数据页面（行数始终 < MIN_ROWS）
  // 由 5 秒超时收条。官方框架若清空壳元素把条冲掉，observer 会立即补挂。
  //
  // ⚠️ 先遣期**只挂顶条**。底部条是「翻到底的快捷入口」，在列表还没铺开时没有意义；
  // 而且先遣 host 里只有这两条，「追加到末尾」等于紧贴第一条下方 → 看起来像两排按钮
  // 挤在顶部（实测 t=199ms 时 y=67 / y=107，只差 40px）。等 mountPagers 迁到正式
  // 兄弟位置时再补挂底条，那时它才落在真正的页面底部。
  var earlyT = 0;
  function mountPagersEarly() {
    // 复刻壳在场时，条挂进复刻壳的列表区（和最终位置同样的几何关系）；
    // 换装后 mountPagers 再迁到官方列表的正式兄弟位置。
    var host = (rpActive() && rp.barHost) || document.getElementById('contentAreaDiv') || document.body;
    if (!host) return;
    if (!page.bars) page.bars = [buildPager(), buildPager()];
    if (page.bars[0].bar.isConnected) return;   // 顶条已在场即算挂好
    page.bars[0].bar.classList.add('otvz-pager-top');
    host.insertBefore(page.bars[0].bar, host.firstChild);
    page.early = true;
    updatePagers();
    if (!earlyT) {
      earlyT = setTimeout(function () {
        earlyT = 0;
        // 5 秒了补丁仍未启用 = 总行数太少（不需要分页/虚拟化），收掉先遣条
        if (page.early && !built && !killed) rollback(false);
      }, 5000);
    }
  }

  function updatePagers() {
    if (!page.bars) return;
    // 显示条件：分页已启用，或官方还在渲染（展示实时进度），
    // 或先遣条还挂在临时位置（此时列表可能一条都没渲染，显示「加载中…」）。
    var show = page.early || (page.on || page.loading) && page.total > 0;
    var txt = page.total > 0
      ? '第 ' + (page.idx + 1) + ' / ' + page.pages + ' 页 · ' + page.total + ' 条'
      : '加载中…';
    for (var i = 0; i < 2; i++) {
      var b = page.bars[i];
      // 底条只有在正式挂载位置时才显示（先遣期它尚未插进 DOM）
      b.bar.style.display = (show && (i === 0 || b.bar.isConnected)) ? '' : 'none';
      if (b.info.textContent !== txt) b.info.textContent = txt;
      b.prev.disabled = page.idx <= 0;
      b.next.disabled = page.idx >= page.pages - 1;
      if (String(page.size) !== b.sel.value) b.sel.value = String(page.size);
    }
  }

  function setPage(idx) {
    if (!page.on) return;
    idx = Math.max(0, Math.min(page.pages - 1, idx));
    if (idx === page.idx) return;
    page.idx = idx;
    computePages();
    try { scroller.scrollTop = 0; } catch (e) {}
    lastTop = -1;
    apply(true);
  }

  function setPageSize(n) {
    if (n !== 50 && n !== 100 && n !== 200) return;
    page.size = n;
    try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch (e) {}
    page.idx = 0;
    computePages();
    try { scroller.scrollTop = 0; } catch (e) {}
    lastTop = -1;
    apply(true);
  }

  // ---------- 应用 ----------
  function applyLevel(c, y0, y1) {
    var n = c.n;
    if (!n || c.top == null || !c.naturalH) return;

    var i0, i1;
    if (c.top + c.naturalH < y0 || c.top > y1) {
      i0 = 1; i1 = 0;                                  // 整段在视口外
    } else {
      // off[] 是「相对首元素顶边」的偏移，所以基准要加上首元素外边距
      var base = c.top + c.brdT + c.padT + c.indent;
      var rel0 = y0 - base, rel1 = y1 - base;
      i0 = 0;
      while (i0 < n && c.off[i0] + c.h[i0] <= rel0) i0++;
      i1 = n - 1;
      while (i1 >= 0 && c.off[i1] >= rel1) i1--;
      if (i0 > n - 1 || i1 < i0) { i0 = 1; i1 = 0; }
    }
    if (i0 === c.p0 && i1 === c.p1) return;

    var i;
    for (i = c.p0; i <= c.p1; i++) {
      if (i < i0 || i > i1) {
        c.items[i].classList.add(c.cls);
        if (c.cls === CLS_ROW) stats.hidRows++; else stats.hidGroups++;
      }
    }
    for (i = i0; i <= i1; i++) {
      if (i < c.p0 || i > c.p1) c.items[i].classList.remove(c.cls);
    }

    // 容器总高恒等于 naturalH：上面用 paddingTop 把可见行顶到原位，
    // 下面用 paddingBottom 把被摘掉的高度补回来。
    if (i0 > i1) {
      c.el.style.paddingTop = c.padT + 'px';
      c.el.style.paddingBottom = (c.padB + c.indent + c.span + c.extra) + 'px';
    } else {
      c.el.style.paddingTop = (c.padT + c.off[i0]) + 'px';
      c.el.style.paddingBottom = (c.padB + (c.span - (c.off[i1] + c.h[i1])) + c.extra) + 'px';
    }
    c.p0 = i0; c.p1 = i1;
  }

  // ---------- 回滚 ----------
  // keepPagers=true：官方正在重建列表（行数暂时不足）时只恢复样式、留下翻页条继续显示
  // 「加载中…」；false：完整退场（kill / 小数据页面 / 错误恢复），翻页条一并拆除。
  function rollback(keepPagers) {
    var a = document.getElementsByClassName(CLS_ROW);
    while (a.length) a[0].classList.remove(CLS_ROW);
    var b = document.getElementsByClassName(CLS_GRP);
    while (b.length) b[0].classList.remove(CLS_GRP);
    var cbox = document.getElementsByClassName(CLS_BOX);
    while (cbox.length) cbox[0].classList.remove(CLS_BOX);
    if (L) release(L);
    for (var k = 0; k < conts.length; k++) release(conts[k]);
    if (keepPagers && page.bars) {
      // 条留在原地（可能仍是先遣位置），等列表重建完再迁回正式位置
      page.on = false;
      document.documentElement.classList.remove('otvz-on');
      active = false; built = false;
      return;
    }
    // 翻页条一并退场（A/B 对照时官方基线必须干净；下次 sync 会重建）
    if (page.bars) {
      for (var i = 0; i < page.bars.length; i++) {
        var bar = page.bars[i].bar;
        if (bar.parentNode) bar.parentNode.removeChild(bar);
      }
      page.bars = null;
    }
    page.on = false;
    page.early = false;
    page.loading = false;
    page.lastRows = -1;
    document.documentElement.classList.remove('otvz-on');
    active = false; built = false;
    // 完整退场时复刻壳也一并撤掉，官方列表恢复可见（A/B 基线必须干净）
    try { destroyReplica(); } catch (e) { /* 忽略 */ }
  }

  var errCount = 0;
  function onError(e) {
    if (++errCount > 3) return;
    try { console.warn('[otvz] 出错，已回滚虚拟滚动:', e && e.message); } catch (_) {}
    rollback();
  }

  // 永久停用（本页生效一次后不再介入）。用于同页 A/B 对照：
  // 开着测一遍 → kill() → 关着再测一遍，同一份数据、同一台机器、同一个页面。
  function kill() {
    killed = true;
    try { rollback(); } catch (e) { /* 忽略 */ }
    return {
      killed: true,
      rowsInDom: qsa('.tab').length,
      otvzOn: document.documentElement.classList.contains('otvz-on'),
      scrollHeight: scroller ? scroller.scrollHeight : null,
    };
  }

  // ---------- 同步 ----------
  function sync(force) {
    if (killed) return;
    var t0 = now();
    useScroller(findScroller());
    if (!scroller) { scheduleRetry(); return; }

    var rows = qsa('.tab');
    if (rows.length < MIN_ROWS) {
      // 官方可能正在重建列表（比如刚刷新/刚收到更新）——只恢复样式，先遣翻页条留着
      // 继续显示「加载中…」；小数据页面（行数始终不足）由 mountPagersEarly 的 5 秒超时收条
      rollback(true);
      // 小数据页面官方很快渲染完，行数一旦稳定就立刻换装，不让复刻壳多占一秒
      if (rpActive()) {
        if (rows.length > 0 && rows.length === rpSmallRows) rpSmallStable++;
        else { rpSmallStable = 0; rpSmallRows = rows.length; }
        if (rpSmallStable >= 1 || rows.length === 0) { try { swapReplica(true); } catch (e) { /* 忽略 */ } }
      }
      return;
    }

    // 先关掉 CSS 兜底层再测量。
    // content-visibility:auto 的元素在屏幕外时 getBoundingClientRect() 返回的是
    // contain-intrinsic-size 估算值（26px），不是真实高度；而下面全靠真实高度算位置。
    // 加 .otvz-on 让那条规则失效，测量才准。
    // （JS 若从未跑到这里，就没人加 .otvz-on，CSS 兜底照常工作。）
    document.documentElement.classList.add('otvz-on');

    // 官方渲染进度检测：DOM 行数比上次 sync 多 = 还在渲染。
    // 挂条不能等 page.on（可见行数 > 一页）——大数据页面刷新后官方要 6~8 秒才渲染完，
    // 这段窗口里可见行数可能长期停在几十行，翻页条就会迟到同样久。
    page.loading = built ? rows.length > page.lastRows : rows.length > 0;
    page.lastRows = rows.length;

    collect();
    linkRowContainersToGroups();

    // 首次必然是全量；窗口尺寸变化也走全量；其余情况只补齐新元素
    var full = !!force || forceFull || !built || !L;
    measure(full);

    // 分页切片必须在测量之后算：切片按「官方可见行」计数，而行可见性
    // （高度是否 > 0）来自测量结果。官方搜索/筛选藏掉的行不占页名额，
    // 所以搜索结果会被自然分页 —— 自带搜索照常可用。
    computePages();
    mountPagers();         // 有列表容器就挂（mountPagers 自带 guard）；显不显示由 updatePagers 决定
    updatePagers();        // 分页未启用且已渲染完 → 藏条；加载中 → 显示实时进度

    // 第一页分页就绪（测量完成、页外容器已藏）→ 复刻壳功成身退，官方列表接管
    if (page.on && page.total > 0) { try { swapReplica(); } catch (e) { /* 忽略 */ } }

    active = true; built = true;
    stats.syncs++;
    stats.lastSyncMs = Math.round(now() - t0);
    if (stats.lastSyncMs > stats.maxSyncMs) stats.maxSyncMs = stats.lastSyncMs;
    lastTop = -1;
    apply(true);
  }

  function scheduleRetry() {
    clearTimeout(retryT);
    retryT = setTimeout(function () { if (!built && !killed) { try { sync(); } catch (e) { onError(e); } } }, 400);
  }

  // ---------- 按滚动位置应用 ----------
  function apply(force) {
    if (!active) return;
    if (!scroller || !scroller.isConnected) { built = false; return; }
    var st = scroller.scrollTop, vh = scroller.clientHeight;
    if (!force && st === lastTop && vh === lastVH) return;
    lastTop = st; lastVH = vh;
    stats.applies++;

    // 分页模式：窗口由「页」决定，与滚动位置无关 —— 页内滚动什么都不用动，
    // 只有翻页 / 每页条数变化 / 结构重同步（这些走 force=true）才需要重算
    if (page.on) {
      if (force) applyPage();
      return;
    }

    if (L) applyLevel(L, st - GRP_MARGIN, st + vh + GRP_MARGIN);
    for (var k = 0; k < conts.length; k++) applyLevel(conts[k], st - ROW_MARGIN, st + vh + ROW_MARGIN);
  }

  // ---------- 事件 ----------
  function onScroll() {
    try { apply(false); } catch (e) { onError(e); return; }
    if (!rafId) {
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        try { apply(true); } catch (e) { onError(e); }
      });
    }
  }

  function schedule() {
    clearTimeout(settleT);
    settleT = setTimeout(function () { try { sync(); } catch (e) { onError(e); } }, SETTLE_MS);
  }

  // 官方若用 scrollIntoView 跳到被我们藏起来的分组，得先放出来
  function installScrollIntoViewGuard() {
    var orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      try {
        for (var node = this; node; node = node.parentElement) {
          if (node.classList && node.classList.contains(CLS_GRP)) node.classList.remove(CLS_GRP);
        }
        var par = this.parentElement;
        for (var k = 0; k < conts.length; k++) if (conts[k].el === par) { release(conts[k]); break; }
        if (L) release(L);
        lastTop = -1;
      } catch (e) { /* 忽略 */ }
      return orig.apply(this, arguments);
    };
  }

  // ---------- 自检与调试 ----------
  function verify(k) {
    if (!built || !scroller) return { note: '未启用，无可校验' };
    k = k || 3;
    var patchedHeight = scroller.scrollHeight;
    var geo = [];
    if (L) geo.push({ name: 'groups', naturalH: +L.naturalH.toFixed(1), rectH: +L.el.getBoundingClientRect().height.toFixed(1) });
    for (var i = 0; i < conts.length && geo.length <= k; i++) {
      var c = conts[i];
      if (c.p0 === 0 && c.p1 === c.n - 1) continue;      // 没被我们摘过，没有可比性
      var rh = c.el.getBoundingClientRect().height;
      if (rh <= 0) continue;                             // 整个组被摘掉时读不到，跳过
      geo.push({ name: 'rows#' + i, naturalH: +c.naturalH.toFixed(1), rectH: +rh.toFixed(1) });
    }

    var rowErr = null, rowSamples = 0, probe = null;
    for (var j = 0; j < conts.length; j++) {
      // 被整容器隐藏（CLS_BOX）的容器虽有非全显窗口，但 display:none 下量不出几何，跳过
      if (conts[j].el.classList.contains(CLS_BOX)) continue;
      if (conts[j].n > 10 && (conts[j].p0 > 0 || conts[j].p1 < conts[j].n - 1)) { probe = conts[j]; break; }
    }
    if (probe) {
      // 采样容器若正被组层藏着，得先把它的组放出来，否则读不到任何几何
      if (L && probe.gi >= 0 && L.items[probe.gi]) L.items[probe.gi].classList.remove(CLS_GRP);
      var model = new Float64Array(probe.n);
      for (var m = 0; m < probe.n; m++) model[m] = probe.off[m];
      release(probe);
      void scroller.offsetHeight;
      var base = probe.el.getBoundingClientRect().top + probe.brdT + probe.padT + probe.indent;
      var mx = 0, cnt = 0;
      for (var q = 0; q < probe.n; q++) {
        var r = probe.items[q].getBoundingClientRect();
        if (r.height <= 0) continue;
        var err = (r.top - base) - model[q];
        if (Math.abs(err) > mx) mx = Math.abs(err);
        cnt++;
      }
      if (cnt) { rowErr = +mx.toFixed(2); rowSamples = cnt; }
    }

    unhideAll();
    void scroller.offsetHeight;
    var naturalHeight = scroller.scrollHeight;
    lastTop = -1;
    try { apply(true); } catch (_) {}

    return {
      pageMode: page.on ? {
        page: page.idx + 1, pages: page.pages, size: page.size, total: page.total,
        note: '分页模式下补丁高度只含当前页；drift = 全量高度 - 本页高度，属预期，不是测量误差',
      } : null,
      scrollHeightPatched: patchedHeight,
      scrollHeightNatural: naturalHeight,
      drift: naturalHeight - patchedHeight,
      containers: geo,
      rowErrMax: rowErr,
      rowErrSamples: rowSamples,
    };
  }

  function geom() {
    if (!scroller) return null;
    return {
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      docHeight: document.documentElement.scrollHeight,
    };
  }

  function dump(limit) {
    limit = limit || 6;
    var out = {
      scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
      clientH: scroller ? scroller.clientHeight : -1,
      scrollH: scroller ? scroller.scrollHeight : -1,
      otvzOn: document.documentElement.classList.contains('otvz-on'),
      active: active, built: built,
      rowsInDom: qsa('.tab').length,
      hiddenRowsInDom: document.getElementsByClassName(CLS_ROW).length,
      hiddenGroupsInDom: document.getElementsByClassName(CLS_GRP).length,
      hiddenBoxesInDom: document.getElementsByClassName(CLS_BOX).length,
      page: { on: page.on, idx: page.idx + 1, pages: page.pages, size: page.size,
              total: page.total, start: page.start, end: page.end, loading: page.loading,
              early: page.early, pagersInDom: document.querySelectorAll('.otvz-pager').length },
    };
    if (L) {
      var lr = L.el.getBoundingClientRect();
      out.L = {
        n: L.n, top: L.top == null ? null : +L.top.toFixed(1),
        padT: L.padT, brdT: L.brdT, indent: +L.indent.toFixed(2),
        naturalH: +L.naturalH.toFixed(1), span: +L.span.toFixed(1), extra: +L.extra.toFixed(1),
        known: L.known, p0: L.p0, p1: L.p1, rectH: +lr.height.toFixed(1),
        stylePadTop: L.el.style.paddingTop || '(未设)',
      };
    }
    out.conts = [];
    for (var i = 0; i < conts.length && out.conts.length < limit; i++) {
      var c = conts[i], r = c.el.getBoundingClientRect();
      out.conts.push({
        gi: c.gi, top: c.top == null ? null : +c.top.toFixed(1),
        naturalH: +c.naturalH.toFixed(1), span: +c.span.toFixed(1), extra: +c.extra.toFixed(1),
        n: c.n, known: c.known, p0: c.p0, p1: c.p1, rectH: +r.height.toFixed(1),
        stylePadTop: c.el.style.paddingTop || '(未设)',
        inHiddenGroup: !!(c.el.closest && c.el.closest('.' + CLS_GRP)),
      });
    }
    return out;
  }

  // =====================================================================
  // 首屏直出（v3 replica）——不等官方，boot 第一毫秒就把第一页摆上桌
  // ---------------------------------------------------------------------
  // 官方打开页面要做两件慢事：① 把 5000+ 条记录全部读进内存模型；② 建 5.6 万个
  // DOM 节点。这期间用户盯着的只有空白和转圈。本模块改变策略：
  //   1. boot 即搭「官方同款壳」：包装链的内联样式 1:1 照抄（宽窄、边距、滚动
  //      位置与官方完全一致），翻页条随壳就位；
  //   2. 直接从 IndexedDB 定向读出第一页要用的分组和行（树序 = root.childIds，
  //      与官方渲染顺序一致；trash 子树跳过），用官方同款模板拼 HTML 摆上桌；
  //   3. 官方的完整渲染放后台继续跑：其列容器 opacity:0 + pointer-events:none
  //      （布局与 IntersectionObserver 全照常——官方分片渲染靠它驱动——只是不画）。
  //   4. 补丁第一页就绪（page.on）→ 摘壳换装，官方列表无缝接管；小数据页面在
  //      行数稳定后立即换装；12 秒兜底强换。
  // 外观零差异：行/组模板逐字符复刻自实拍 DOM（favicon 雪碧图 1136 个域名格子
  // 号从官方源码整体搬运；不在图内的域名走官方同款 gstatic favicon 服务）。
  // =====================================================================
  var rp = { active: false, swapped: false, shell: null, listEl: null, barHost: null,
    navColEl: null,
    hidEl: null,
    scroller: null, mo: null, timer: 0, swapT: 0, tStart: 0, tRows: 0, rows: 0, scrollerTop: 0 };
  var rpSmallRows = -1, rpSmallStable = 0;
  function rpActive() { return rp.active && !rp.swapped; }
  function rpStatus() { return { active: rp.active, swapped: rp.swapped, rows: rp.rows, tRowsMs: rp.tRows ? Math.round(rp.tRows - rp.tStart) : 0 }; }

  function rpEsc(t) { var d = document.createElement('p'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }
  function rpEscAttr(u) { return String(u == null ? '' : u).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  // 官方 ol()/Ei()/ei() 的等价实现：从 URL 算出雪碧图映射键（含 docs.google 各文档类型特例）
  function rpHost(u) {
    if (!u) return '';
    var s = String(u);
    if (s.toLowerCase().indexOf('file://') === 0) return '';
    if (s.indexOf('://docs.google.com/spreadsheets/d/') !== -1) return 'docs.google.com-spreadsheets';
    if (s.indexOf('://docs.google.com/document/d/') !== -1) return 'docs.google.com-document';
    if (s.indexOf('://docs.google.com/presentation/d/') !== -1) return 'docs.google.com-presentation';
    if (s.indexOf('://docs.google.com/forms/d/') !== -1) return 'docs.google.com-forms';
    if (s.indexOf('://docs.google.com/drawings/d/') !== -1) return 'docs.google.com-drawings';
    var t = s;
    if (t.indexOf('//') === 0) t = 'http:' + t;
    if (t.indexOf('://') === -1) t = 'http://' + t;
    t = t.substring(t.indexOf('://') + 3);
    if (t.indexOf('/') !== -1) t = t.substring(0, t.indexOf('/'));
    if (t.indexOf(':') !== -1) t = t.substring(0, t.indexOf(':'));
    if (t.indexOf('?') !== -1) t = t.substring(0, t.indexOf('?'));
    if (t.indexOf('#') !== -1) t = t.substring(0, t.indexOf('#'));
    t = t.toLowerCase();
    if (t.indexOf('www.') === 0) t = t.substring(4);
    if (t.length > 14 && t.substring(t.length - 14) === '.wikipedia.org') t = 'wikipedia.org';
    return t;
  }

  // 域名→雪碧图格子号（官方源码 1:1 搬运；占位符由构建脚本替换）
  var RP_SPRITE = (function () {
    var m = {}, a = "calendar.google.com:0,docs.google.com-document:1,docs.google.com-drawings:2,docs.google.com-forms:3,docs.google.com-presentation:4,docs.google.com-spreadsheets:5,drive.google.com:6,mail.google.com:7,meet.google.com:8,sites.google.com:9,google.ca:10,google.co.in:10,google.co.jp:10,google.co.uk:10,google.com:10,google.com.br:10,google.com.hk:10,google.de:10,google.fr:10,google.it:10,google.ru:10,withgoogle.com:10,facebook.com:11,fb.com:11,fb.me:11,azure.com:12,microsoft.com:12,office365.com:12,onedrive.com:12,sharepoint.com:12,windows.com:12,youtu.be:13,youtube.com:13,amazonaws.com:14,apple.com:15,instagram.com:16,imgsmail.ru:17,mail.ru:17,twitter.com:18,x.com:18,dzen.ru:19,linkedin.com:20,live.com:21,outlook.com:21,cloud.microsoft:22,office.com:22,amazon.com:23,amazon.com.br:23,amazonalexa.com:23,wikipedia.org:24,github.com:25,bing.com:26,fastly.net:27,netflix.com:28,netflix.net:28,wordpress.org:29,skype.com:30,gandi.net:31,pinterest.com:32,goo.gl:33,yahoo.com:34,icloud.com:35,tiktok.com:36,msn.com:37,spotify.com:38,googledomains.com:39,adobe.com:40,adobe.io:40,roblox.com:41,chatgpt.com:42,vimeo.com:43,zoom.com:44,zoom.us:44,qq.com:45,workers.dev:46,baidu.com:47,nginx.org:48,mozilla.org:49,news.ycombinator.com:50,zerohedge.com:51,protopage.com:52,news.bbc.co.uk:53,nic.ru:54,opera.com:55,yandex.ru:56,samsung.com:57,smartthings.com:57,f5.com:58,nginx.com:58,wordpress.com:59,wp.com:59,reddit.com:60,ubnt.com:61,ui.com:61,discord.com:62,discord.gg:62,discordapp.com:62,t.me:63,telegram.me:63,telegram.org:63,blogger.com:64,blogspot.com:64,europa.eu:65,userapi.com:66,vk.com:66,vk.ru:66,github.io:67,snapchat.com:68,epicgames.com:69,unity3d.com:70,apache.org:71,nih.gov:72,amazonvideo.com:73,primevideo.com:73,mailinabox.email:74,dns.google:75,intuit.com:76,dropbox.com:77,godaddy.com:78,mi.com:79,xiaomi.com:79,archive.org:80,reg.ru:81,nytimes.com:82,tumblr.com:83,paypal.com:84,one.one:85,shopify.com:86,applovin.com:87,telekom.de:88,flickr.com:89,soundcloud.com:90,medium.com:91,webex.com:92,w3.org:93,taboola.com:94,theguardian.com:95,cnn.com:96,rubiconproject.com:97,vungle.com:98,oracle.com:99,forbes.com:100,creativecommons.org:101,nic.direct:102,nic.network:102,avast.com:103,ozon.ru:104,bbc.com:105,cpanel.net:106,pubmatic.com:107,miui.com:108,weather.com:109,ebay.co.uk:110,ebay.com:110,ebay.de:110,ebay.it:110,sciencedirect.com:111,twitch.tv:112,t-online.de:113,doi.org:114,researchgate.net:115,bbc.co.uk:116,mit.edu:117,oxylabs.io:118,gmail.com:119,googleblog.com:119,share.google:119,cisco.com:120,sourceforge.net:121,nist.gov:122,android.com:123,canva.com:124,imdb.com:125,ubuntu.com:126,mts.ru:127,stripe.com:128,roku.com:129,pages.dev:130,who.int:131,hubspot.com:132,openai.com:133,linktr.ee:134,booking.com:135,meraki.com:136,dropcatch.com:137,launchpad.net:138,wikimedia.org:139,biomedcentral.com:140,springer.com:140,hp.com:141,telekom.net:142,afternic.com:143,ibm.com:144,force.com:145,salesforce.com:145,site.com:145,tinyurl.com:146,reuters.com:147,hcaptcha.com:148,myshopify.com:149,service.gov.uk:150,www.gov.uk:150,alibaba.com:151,nature.com:152,triplinkintl.com:153,duckdns.org:154,etsy.com:155,harvard.edu:156,appsflyer.com:157,ok.ru:158,drom.ru:159,amazon.ca:160,amazon.co.jp:160,amazon.co.uk:160,amazon.com.au:160,amazon.com.mx:160,amazon.de:160,amazon.es:160,amazon.fr:160,amazon.in:160,amazon.it:160,php.net:161,weibo.com:162,wiley.com:163,autodesk.com:164,launchdarkly.com:165,wb.ru:166,wildberries.ru:166,bilibili.com:167,opendns.com:168,ea.com:169,weebly.com:170,issuu.com:171,gnu.org:172,slack.com:173,checkpoint.com:174,cdc.gov:175,un.org:176,trustpilot.com:177,aliyun.com:178,wsj.com:179,naver.com:180,ezvizlife.com:181,washingtonpost.com:182,yahoo.co.jp:183,dell.com:184,tradingview.com:185,nasa.gov:186,selectel.ru:187,bloomberg.com:188,stanford.edu:189,nvidia.com:190,zendesk.com:191,aol.com:192,ivi.ru:193,dailymotion.com:194,plesk.com:195,calendly.com:196,temu.com:197,tp-link.com:198,unsplash.com:199,yandex.com:200,yandex.com.tr:200,indeed.com:201,vivo.com:202,vivo.com.cn:202,vivoglobal.com:202,globo.com:203,gitlab.com:204,cookiedatabase.org:205,debian.org:206,ngenix.net:207,dailymail.co.uk:208,line.me:209,gamepass.com:210,xboxlive.com:210,ip-api.com:211,163.com:212,businessinsider.com:213,pixabay.com:214,netangels.ru:215,taobao.com:216,huawei.com:217,espn.com:218,espn.com.ve:218,supercell.com:219,cloudns.net:220,crpt.ru:221,steamcommunity.com:222,adriver.ru:223,aliexpress.com:224,intel.com:225,brave.com:226,statista.com:227,duckduckgo.com:228,amazontrust.com:229,go.com:230,bsky.app:231,sohu.com:232,arubanetworks.com:233,cnbc.com:234,g.page:235,sina.com.cn:236,eventbrite.com:237,mikrotik.com:238,quora.com:239,name.com:240,mcafee.com:241,hostgator.com:242,goodreads.com:243,npr.org:244,mysql.com:245,scribd.com:246,duolingo.com:247,gosuslugi.ru:248,substack.com:249,walmart.com:250,mediatek.com:251,shein.com:252,foxnews.com:253,behance.net:254,stackexchange.com:255,stackoverflow.com:255,indiatimes.com:256,paloaltonetworks.com:257,slideshare.net:258,docker.com:259,docker.io:259,wired.com:260,sberbank.ru:261,arxiv.org:262,ft.com:263,speedtest.net:264,2gis.com:265,360.cn:266,thexh.live:267,xhaccess.com:267,xhamster.com:267,xhamster.desi:267,xhamster1.desi:267,xhamster19.com:267,xhamster2.com:267,xhamster45.desi:267,xhname.com:267,xhopen.com:267,xhsocial.com:267,xhspot.com:267,firefox.com:268,markmonitor.com:269,atlassian.com:270,atlassian.net:270,dynatrace.com:271,time.com:272,fandom.com:273,uk.com:274,visualstudio.com:275,usatoday.com:276,palmplaystore.com:277,trendmicro.com:278,patreon.com:279,capcut.com:280,cookielaw.org:281,tandfonline.com:282,t-mobile.com:283,uol.com.br:284,oup.com:285,tplinkcloud.com:286,deviantart.com:287,fast.com:288,okta.com:289,wix.com:290,tripadvisor.com:291,cornell.edu:292,eset.com:293,teamviewer.com:294,ca.gov:295,telegraph.co.uk:296,nbcnews.com:297,hotjar.com:298,rakuten.co.jp:299,timeweb.ru:300,grammarly.com:301,deepl.com:302,berkeley.edu:303,surveymonkey.com:304,expireddomains.com:305,oraclecloud.com:306,icloud-content.com:307,avito.ru:308,playstation.com:309,ieee.org:310,ikea.com:311,klaviyo.com:312,mdpi.com:313,target.com:314,loc.gov:315,britannica.com:316,jotform.com:317,digitalocean.com:318,accuweather.com:319,redhat.com:320,verisign.com:321,moe.video:322,nike.com:323,free.fr:324,merriam-webster.com:325,att.net:326,threads.com:327,squarespace.com:328,nintendo.com:329,cnet.com:330,fontawesome.com:331,sagepub.com:332,unesco.org:333,techcrunch.com:334,cbsnews.com:335,ovh.net:336,elpais.com:337,independent.co.uk:338,datadoghq.com:339,stackadapt.com:340,noaa.gov:341,yelp.com:342,viber.com:343,consultant.ru:344,dyndns.org:345,bluehost.com:346,tencent.com:347,cambridge.org:348,dreamhost.com:349,ups.com:350,intercom.io:351,conviva.com:352,giphy.com:353,imgur.com:354,optimizely.com:355,ted.com:356,lemonde.fr:357,eepurl.com:358,mailchimp.com:358,spiegel.de:359,anydesk.com:360,seznam.cz:361,bitrix24.ru:362,watchlist-internet.at:363,ya.ru:364,yandex.kz:364,wps.com:365,cursor.sh:366,perplexity.ai:367,rt.ru:368,irs.gov:369,asus.com:370,anthropic.com:371,zillow.com:372,allaboutcookies.org:373,newrelic.com:374,stripchat.com:375,uber.com:376,box.com:377,homedepot.com:378,bandcamp.com:379,iso.org:380,bugsnag.com:381,marriott.com:382,shopee.co.id:383,shopee.com.br:383,mercadolibre.com.ar:384,mercadolibre.com.mx:384,mercadolivre.com.br:384,python.org:385,mckinsey.com:386,ring.com:387,kick.com:388,mega.co.nz:389,ys7.com:390,sophos.com:391,wp.pl:392,nikkei.com:393,mlb.com:394,otto.de:395,openstreetmap.org:396,prnewswire.com:397,fda.gov:398,allegro.pl:399,myspace.com:400,fiverr.com:401,washington.edu:402,wattpad.com:403,people.com:404,globalsign.com:405,hbr.org:406,theverge.com:407,ameblo.jp:408,apnews.com:409,rakuten.com:410,welt.de:411,wpguardian.com:412,wpguardian.io:412,sedo.com:413,disneyplus.com:414,lenovo.com:415,blackberry.com:416,blackberry.net:416,bild.de:417,no-ip.com:418,mayoclinic.org:419,ddnss.de:420,daum.net:421,princeton.edu:422,thenai.org:423,erome.com:424,disqus.com:425,academia.edu:426,pexels.com:427,unpkg.com:428,lefigaro.fr:429,claude.ai:430,usps.com:431,zoho.com:432,freepik.com:433,hostgator.com.br:434,pornhub.com:435,pornhub.org:435,abovedomains.com:436,onlyfans.com:437,discogs.com:438,usda.gov:439,investopedia.com:440,tawk.to:441,cloudinary.com:442,frontiersin.org:443,figma.com:444,latimes.com:445,linode.com:446,focus.de:447,agoda.com:448,livejournal.com:449,change.org:450,chess.com:451,synology.com:452,airbnb.com:453,webmd.com:454,miwifi.com:455,ndtv.com:456,qualtrics.com:457,xvideos-ar.com:458,xvideos.com:458,xvideos.es:458,xvideos2.com:458,xvv1deos.com:458,worldbank.org:459,arcgis.com:460,hm.com:461,healthline.com:462,deloitte.com:463,jetbrains.com:464,bankofamerica.com:465,www.gov.br:466,biblegateway.com:467,vercel.app:468,eu.com:469,state.gov:470,coupang.com:471,themeforest.net:472,jimdo.com:473,life360.com:474,readthedocs.io:475,readthedocs.org:475,kontur.ru:476,wyzecam.com:477,webempresa.eu:478,fidelity.com:479,genius.com:480,starlink.com:481,youku.com:482,epa.gov:483,rutube.ru:484,nationalgeographic.com:485,poki.com:486,typeform.com:487,agora.io:488,zhihu.com:489,character.ai:490,chaturbate.com:491,ryanair.com:492,kleinanzeigen.de:493,pbs.org:494,umich.edu:495,playrix.com:496,repubblica.it:497,weforum.org:498,eporner.com:499,lowes.com:500,theatlantic.com:501,jd.com:502,txnhh.com:503,xnxx-arabic.com:503,xnxx.com:503,xnxx.es:503,xnxx.health:503,xnxx.tv:503,xnxx2.com:503,corriere.it:504,smilewanted.com:505,whitehouse.gov:506,note.com:507,caixa.gov.br:508,kwai.com:509,pccc.com:510,kickstarter.com:511,theconversation.com:512,onet.pl:513,nic.io:514,elmundo.es:515,binance.com:516,ipify.org:517,columbia.edu:518,nexusmods.com:519,pixiv.net:520,kueezrtb.com:521,netgear.com:522,onesignal.com:523,costco.com:524,faphouse.com:525,faphouse2.com:525,rackspace.com:526,odoo.com:527,gartner.com:528,amemv.com:529,snapkit.com:530,garmin.com:531,xerox.com:532,ubi.com:533,clever.com:534,flipkart.com:535,ecosia.org:536,quizlet.com:537,bol.com:538,ancestry.com:539,rambler.ru:540,deepseek.com:541,nypost.com:542,upwork.com:543,infobae.com:544,ox.ac.uk:545,bidmachine.io:546,hotstar.com:547,nextcloud.com:548,huffingtonpost.com:549,huffpost.com:549,moneycontrol.com:550,redfin.com:551,ipinfo.io:552,news.com.au:553,spamhaus.org:554,oecd.org:555,hilton.com:556,rbc.ru:557,sofascore.com:558,ameba.jp:559,us.com:560,coursera.org:561,keenetic.io:562,marca.com:563,as.com:564,adblockplus.org:565,xing.com:566,letterboxd.com:567,bfmtv.com:568,goal.com:569,n-tv.de:570,trendyol.com:571,crazygames.com:572,ilovepdf.com:573,cbc.ca:574,notion.so:575,tesla.com:576,lwsdns.com:577,dribbble.com:578,apa.org:579,tailscale.com:580,fortune.com:581,gsmarena.com:582,warnerbros.com:583,tabelog.com:584,lge.com:585,idnes.cz:586,plos.org:587,wise.com:588,meta.com:589,sapo.pt:590,espncricinfo.com:591,tnaflix.com:592,yale.edu:593,usercentrics.eu:594,archiveofourown.org:595,utorrent.com:596,olx.pl:597,hostinger.com:598,skysports.com:599,economist.com:600,gofundme.com:601,yastatic.net:602,finn.no:603,jstor.org:604,clarin.com:605,skroutz.gr:606,sahibinden.com:607,psychologytoday.com:608,hltv.org:609,riotgames.com:610,netlify.app:611,1c.ru:612,fc2.com:613,amd.com:614,lanacion.com.ar:615,meethue.com:616,ultimate-guitar.com:617,classlink.com:618,gismeteo.ru:619,dafont.com:620,cookpad.com:621,dcinside.com:622,megafon.ru:623,olx.com.br:624,pandora.com:625,aftonbladet.se:626,pendo.io:627,diretta.it:628,flashscore.com:628,flashscore.fr:628,flashscore.mobi:628,att.com:629,edna.ru:630,aparat.com:631,dmm.co.jp:632,hotpepper.jp:633,upenn.edu:634,publicnode.com:635,he.net:636,elconfidencial.com:637,jw.org:638,kicker.de:639,alipay.com:640,makemytrip.com:641,superhosting.bg:642,rule34.xxx:643,vinted.fr:644,emag.ro:645,psu.edu:646,bund.de:647,vg.no:648,epicgames.dev:649,indiamart.com:650,furaffinity.net:651,itmedia.co.jp:652,vnexpress.net:653,lichess.org:654,nu.nl:655,dhl.com:656,spankbang.com:657,ad.nl:658,namu.wiki:659,pornpics.com:660,abc.net.au:661,leboncoin.fr:662,cricbuzz.com:663,janitorai.com:664,tradplusad.com:665,rightmove.co.uk:666,lequipe.fr:667,boyfriendtv.com:668,dlsite.com:669,acesso.gov.br:670,cnnbrasil.com.br:671,remove.bg:672,shop.app:673,trello.com:674,donga.com:675,meesho.com:676,marktplaats.nl:677,ynet.co.il:678,wordwall.net:679,bilibili.tv:680,sciencedaily.com:681,gazzetta.it:682,nsone.net:683,bmj.com:684,kakao.com:685,fmkorea.com:686,mydramalist.com:687,parklogic.com:688,poste.it:689,wiktionary.org:690,tabor.ru:691,businesswire.com:692,idealista.com:693,idealista.it:693,argos.co.uk:694,fetlife.com:695,livescore.com:696,safety.google:697,admin.ch:698,usnews.com:699,service-now.com:700,fanfiction.net:701,tbank.ru:702,tinkoff.ru:702,zalando.de:703,postgresql.org:704,hln.be:705,litnet.com:706,youporn.com:707,maricopa.gov:708,myntra.com:709,merkur.de:710,kernel.org:711,vietnam.vn:712,dw.com:713,livedoor.com:714,labs.google:715,pimpbunny.com:716,excite.co.jp:717,inven.co.kr:718,lc.chat:719,ladepeche.fr:720,naukri.com:721,wisc.edu:722,championat.com:723,noodlemagazine.com:724,ukdevilz.com:724,futbin.com:725,buzzfeed.com:726,sotwe.com:727,cdiscount.com:728,justdial.com:729,polybuzz.ai:730,rustdesk.com:731,jusbrasil.com.br:732,redtube.com:733,tori.fi:734,wayground.com:735,actu.fr:736,ppomppu.co.kr:737,ilfattoquotidiano.it:738,dantri.com.vn:739,xxxbp.tv:740,aternos.org:741,ucla.edu:742,subito.it:743,canada.ca:744,tagesschau.de:745,beboo.ru:746,uci.edu:747,umn.edu:748,calculator.net:749,fedex.com:750,autotrader.co.uk:751,haberler.com:752,suumo.jp:753,blooket.com:754,siemens.com:755,kahoot.it:756,hollywoodbets.net:757,funpay.com:758,youjizz.com:759,e621.net:760,blackrussia.online:761,thisvid.com:762,cam.ac.uk:763,ruliweb.com:764,id.me:765,ajio.com:766,ixl.com:767,zozo.jp:768,asurascans.com:769,mediaexpert.pl:770,gcash.com:771,pornone.com:772,carsensor.net:773,aznude.com:774,aljazeera.com:775,leroymerlin.es:776,leroymerlin.fr:776,hitomi.la:777,turkiye.gov.tr:778,boursorama.com:779,fdown.net:780,e-hentai.org:781,tenki.jp:782,missav.ai:783,missav.live:783,missav.ws:783,missav123.com:783,njavtv.com:783,imhentai.xxx:784,mangabuff.ru:785,weathernews.jp:786,pornhat.com:787,pornhat.one:787,sportybet.com:788,navitime.co.jp:789,rule34video.com:790,porkbun.com:791,buydomains.com:792,fapello.com:793,dagbladet.no:794,kaspi.kz:795,cardgames.io:796,bookmyshow.com:797,novinky.cz:798,coolmathgames.com:799,elsevier.com:800,boardgamearena.com:801,amap.com:802,karnataka.gov.in:803,18comic.vip:804,mbga.jp:805,mangago.me:806,inps.it:807,ixxx.com:808,cronista.com:809,iltalehti.fi:810,zedge.net:811,simpcity.cr:812,jable.tv:813,game8.jp:814,syosetu.com:815,newsweek.com:816,arca.live:817,ilmeteo.it:818,cityheaven.net:819,eenadu.net:820,toyhou.se:821,nesine.com:822,otomoto.pl:823,sozcu.com.tr:824,deltafibernederland.nl:825,blic.rs:826,betway.co.za:827,protothema.gr:828,jutarnji.hr:829,immobiliare.it:830,imagefap.com:831,3bmeteo.com:832,property24.com:833,index.hr:834,24h.com.vn:835,myinstants.com:836,starfall.com:837,ovhcloud.com:838,jagran.com:839,cardmarket.com:840,varzesh3.com:841,ekstrabladet.dk:842,ssstik.io:843,fpo.xxx:844,bookmark.xxx:845,huggingface.co:846,superporn.com:847,netkeiba.com:848,ficbook.net:849,luxuretv.com:850,wpastra.com:851,sexvid.xxx:852,pussyspace.com:853,klikbca.com:854,typing.com:855,shutterstock.com:856,eff.org:857,leparisien.fr:858,gamewith.jp:859,eltiempo.es:860,hdtube.porn:861,forebet.com:862,overwolf.com:863,letsporn.com:864,rat.xxx:865,sxyprn.com:866,ioh.co.id:867,caliente.mx:868,eci.gov.in:869,itch.io:870,bt.dk:871,mangafire.to:872,theblowers.com:873,sondakika.com:874,lausd.net:875,epfindia.gov.in:876,testbook.com:877,porn300.com:878,fuq.com:879,kohls.com:880,ijavhd.com:881,programme-tv.net:882,123av.com:883,nosv.org:884,supjav.com:885,fatalmodel.com:886,iplt20.com:887,hanime1.me:888,terra.com.br:889,absher.sa:890,joyclub.de:891,sinoptik.ua:892,sexlog.com:893,casinoplus.com.ph:894,mat6tube.com:895,aajtak.in:896,goodreturns.in:897,tabletki.ua:898,kooora.com:899,jennymovies.com:900,tokyomotion.net:901,motherless.com:902,listcrawler.eu:903,bingoplus.com:904,newyorker.com:905,parivahan.gov.in:906,snaptik.app:907,markt.de:908,rakuten-sec.co.jp:909,wnacg.com:910,redbus.in:911,therapservices.net:912,croxyproxy.com:913,iporntv.net:914,myreadingmanga.info:915,bikewale.com:916,alura.com.br:917,moviebox.ph:918,lioden.com:919,fedoraproject.org:920,serviporno.com:921,hochi.news:922,qorno.com:923,porno666.fo:924,librus.pl:925,kakuyomu.jp:926,syosetu.org:927,fastdl.app:928,trilltrill.jp:929,nickfinder.com:930,ss.com:931,mechacomic.jp:932,skokka.com:933,theqoo.net:934,goojara.to:935,kompoz2.com:936,afip.gob.ar:937,rkv1.com:938,screener.in:939,piccoma.com:940,dogdrip.net:941,betika.com:942,ewaybillgst.gov.in:943,spaggiari.eu:944,twpornstars.com:945,chordtela.com:946,ladies.de:947,instructure.com:948,kingbokep.tv:949,desitales2.com:950,freepornvideo.sex:951,okxxx1.com:952,pussyboy.net:953,fao.org:954,skelbiu.lt:955,hentai.name:956,xxxvideo.link:957,sexalarab.com:958,redwap.sex:959,imgsrc.ru:960,afribaba.com:961,patria.org.ve:962,fabswingers.com:963,xorgasmo.com:964,arabx.cam:965,oreilly.com:966,girlschannel.net:967,meitu.com:968,nustargame.com:969,arabxn.sex:970,tktube.com:971,mangabuddy.com:972,pornocarioca.com:973,arabtnt.com:974,impots.gouv.fr:975,meteofor.com.ua:976,momon-ga.com:977,sexnyk.com:978,alphapolis.co.jp:979,an1.com:980,happymh.com:981,ptgaming.ph:982,tjk.org:983,anses.gob.ar:984,administracionelectronica.gob.es:985,manhwaweb.com:986,bakusai.com:987,autoplius.lt:988,ojogodobicho.com:989,yallakora.com:990,vymanga.com:991,promiedos.com.ar:992,w3schools.com:993,czbooks.net:994,darkero.com:995,mileroticos.com:996,ftc.gov:997,skipthegames.com:998,escort.club:999,zearn.org:1001,goal7.co:1002,zebawy.com:1003,arbada.com:1004,letras.mus.br:1005,xvideosputaria.com:1006,xosodaiphat.com:1007,xpaja.net:1008,twkan.com:1009,betking.com:1010,emaktab.uz:1011,indown.io:1012,humoruniv.com:1013,ecnavi.jp:1014,hotxv.com:1015,conectate.com.do:1016,jra.jp:1017,indiansexstories3.com:1018,sarkariresult.com.cm:1019,dto.jp:1020,battle.net:1021,animanch.com:1022,nz.ua:1023".split(','), i, p, c;
    for (i = 0; i < a.length; i++) {
      p = a[i]; c = p.lastIndexOf(':');
      if (c > 0) m[p.substring(0, c)] = +p.substring(c + 1);
    }
    return m;
  })();

  // 官方 pr() 的等价实现：图内域名用 iconGrid 雪碧图，图外用 gstatic favicon
  function rpFav(url) {
    var k = rpHost(url);
    if (k && Object.prototype.hasOwnProperty.call(RP_SPRITE, k)) {
      var n = RP_SPRITE[k];
      var x = -16 * (n % 32), y = -16 * Math.floor(n / 32);
      return '<div style="flex: 0 0 auto; display: inline-block; width: 16px; height: 16px; margin-inline-start: 5px; cursor: move; background-size: 512px 512px; background-repeat: no-repeat; background-position: ' + x + 'px ' + y + 'px; background-image: url(&quot;images/iconGrid.webp&quot;);"></div>';
    }
    var src = k ? 'https://t2.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://' + k + '&size=32' : 'images/globe.png';
    return '<div style="flex: 0 0 auto; display: inline-block; width: 16px; height: 16px; margin-inline-start: 5px; cursor: move;"><img draggable="false" src="' + rpEscAttr(src) + '" style="border-style: none; width: 16px; height: 16px;"></div>';
  }

  function rpPad2(n) { return n < 10 ? '0' + n : '' + n; }
  // 官方日期行「2026/9/19 16:17 - 4小时前」的等价实现（格式自实拍 DOM 标定）
  function rpDateLine(ts) {
    var d = new Date(ts || Date.now());
    var diff = Date.now() - (ts || Date.now());
    if (diff < 0) diff = 0;
    var rel;
    if (diff < 60000) rel = '刚刚';
    else if (diff < 3600000) rel = Math.floor(diff / 60000) + '分钟前';
    else if (diff < 86400000) rel = Math.floor(diff / 3600000) + '小时前';
    else rel = Math.floor(diff / 86400000) + '天前';
    return '<span style="unicode-bidi: plaintext;">' + d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + '</span> <span style="unicode-bidi: plaintext;">' + rpPad2(d.getHours()) + ':' + rpPad2(d.getMinutes()) + '</span> - <span style="unicode-bidi: plaintext;">' + rel + '</span>';
  }

  // 行模板：逐字符复刻实拍 .tab DOM（链接加 target=_blank，复刻阶段点开不留 phantom 状态）
  function rpRow(t) {
    return '<div data-id="' + rpEscAttr(t.id) + '" class="tab"><div class="tabInner"><div class="favIconDiv tabLinkText">' + rpFav(t.url)
      + '</div><a draggable="false" tabindex="-1" class="tabLink tabLinkText" target="_blank" rel="noopener" href="' + rpEscAttr(t.url) + '" style="cursor: default;"><span class="tabLinkText tabLinkTextStripesPossible" style="cursor: pointer;">'
      + rpEsc(t.title || t.url || 'Untitled') + '</span></a>'
      + '<picture class="lightDarkPicture flag tabMoreButton" draggable="false" style="width: 13px; height: 11px;"><img class="lightDarkInnerImg" data-light-src="images/vertical-ellipses.png" data-dark-src="images/vertical-ellipses-dark.png" draggable="false" src="images/vertical-ellipses.png" style="max-width: 13px; max-height: 11px;"></picture>'
      + '<div style="display: none; white-space: nowrap;"></div></div></div>';
  }

  // 组模板：逐字符复刻实拍 .tabGroup DOM（头部=label+日期行+折页钮+全部还原+更多，体=childContainer 行）
  function rpGroup(g, tabs) {
    var label = g.title ? String(g.title) : (tabs.length + ' 个标签页');
    var rows = '';
    for (var i = 0; i < tabs.length; i++) rows += rpRow(tabs[i]);
    return '<div data-id="' + rpEscAttr(g.id) + '" class="tabGroup" style="display: block; margin-inline: 0px; margin-block: 9px 4px;">'
      + '<div tabindex="0" class="tabGroupBody" style="padding-top: 2px; padding-bottom: 2px; padding-inline: 0px; margin-inline: 10px; margin-block: 10px; min-height: 70px;">'
      + '<div style="display: flex; align-items: flex-start; margin-inline: 8px 6px;">'
      + '<div style="position: relative; display: flex; flex: 1 1 auto; margin: 3px; padding-inline-start: 8px;">'
      + '<div style="position: absolute; left: -30px; top: 9px; width: 36px; height: 26px;"></div>'
      + '<div style="display: none;"><picture class="lightDarkPicture" draggable="false" style="width: 19px; height: 19px; display: inline-block; margin-inline: 3px 4px; position: relative; top: 12px;"><img class="lightDarkInnerImg" data-light-src="images/lock.png" data-dark-src="images/lock-dark.png" draggable="false" src="images/lock.png" style="max-width: 19px; max-height: 19px;"></picture></div>'
      + '<div class="tabGroupLabelText" style="position: relative; z-index: 0; padding: 2px; white-space: break-spaces; overflow-wrap: anywhere; box-sizing: border-box; unicode-bidi: plaintext; display: flex; align-items: flex-start; margin-inline: 5px 10px; margin-top: 5px; flex: 1 1 auto; color: var(--text-color-weak); cursor: pointer;"><span class="editInPlaceLabelSpan">' + rpEsc(label) + '</span></div></div>'
      + '<div style="display: flex; flex-direction: column; align-items: flex-end;">'
      + '<div style="display: flex; margin-inline-end: 15px; margin-block-start: 8px; cursor: pointer;">'
      + '<div style="flex: 1 1 auto; text-align: end; font-size: 11px; margin-bottom: 1px; color: var(--text-color-weak);">' + rpDateLine(g.createDate) + '</div>'
      + '<div class="foldButton" data-otvz-pending="1" aria-label="收起分组（加载中）" title="还在加载，稍后可折叠" style="position: relative; flex: 0 0 auto; width: 16px; height: 16px; margin-inline: 8px -1px; margin-block-start: -1px; cursor: pointer;"><picture class="lightDarkPicture" draggable="false" style="width: 4.8px; height: 7.2px; position: absolute; left: 5.6px; top: 5.4px; display: inline-block; transform-origin: center center; transition: transform 140ms ease-out; transform: rotate(90deg);"><img class="lightDarkInnerImg" data-light-src="images/tree-twistie-closed-light.png" data-dark-src="images/tree-twistie-closed-dark.png" draggable="false" src="images/tree-twistie-closed-light.png" style="max-width: 4.8px; max-height: 7.2px;"></picture></div>'
      + '<div style="display: none; white-space: nowrap; flex: 0 0 auto; margin-inline: 12px 2px;"></div></div>'
      + '<div style="margin-top: 0px; margin-inline-end: 7px; text-align: end;">'
      + '<div class="controlButton" data-otvz-pending="1" title="还在加载，稍后可用" style="position: relative;"><picture class="lightDarkPicture" draggable="false" style="width: 13px; height: 13px; flex: 0 0 auto; position: relative; padding-inline: 9px 8px;"><img class="lightDarkInnerImg" data-light-src="images/open.png" data-dark-src="images/open-dark.png" draggable="false" src="images/open.png" style="max-width: 13px; max-height: 13px;"></picture><div style="font-size: 11px; color: var(--blue-control); padding-top: 4px; padding-bottom: 4px;">全部还原</div></div>'
      + '<div class="controlButton" data-otvz-pending="1" title="还在加载，稍后可用" style="position: relative;"><div style="position: absolute; display: none; top: 0px; z-index: 2;"><div class="dropdown-selection" style="margin-bottom: 20px;"><div></div></div></div><picture class="lightDarkPicture" draggable="false" style="width: 12px; height: 12px; flex: 0 0 auto; position: relative; padding-inline: 9px 8px;"><img class="lightDarkInnerImg" data-light-src="images/vertical-ellipses.png" data-dark-src="images/vertical-ellipses-dark.png" draggable="false" src="images/vertical-ellipses.png" style="max-width: 12px; max-height: 12px;"></picture><div style="font-size: 11px; color: var(--blue-control); padding-top: 4px; padding-bottom: 4px;">更多…</div></div>'
      + '</div></div></div>'
      + '<div style="display: block; overflow: visible;">'
      + '<div class="horizDivider" style="margin-top: 0px; margin-bottom: 4px; margin-inline: 24px 14px; border-bottom: 1px solid var(--border-color); display: flex;"></div>'
      + '<div class="tabLinkText" style="position: relative; z-index: 0; padding: 2px; white-space: break-spaces; overflow-wrap: anywhere; box-sizing: border-box; unicode-bidi: plaintext; margin-top: 4px; margin-bottom: 8px; margin-inline: 30px 13px; display: none; color: var(--text-color-weak); cursor: pointer;"><span class="editInPlaceLabelSpan"></span></div>'
      + '<div style="display: none;"></div>'
      + '<div class="childContainer" style="padding-inline: 1px; padding-top: 4px; padding-bottom: 12px;">' + rows + '</div>'
      + '</div></div></div>';
  }

  // 壳：官方包装链的内联样式 1:1 照抄（63px 顶栏让位 + fixed 列 + 滚动容器 + 全宽列表区）
  //
  // 左侧预留（v3.1）：官方是三栏布局 —— navCol(侧栏, 固定 300px, margin-inline-end:-12px)
  // + centerCol(中栏, flex:1) + quickAccessCol(右栏, 折叠态宽 0)，三栏容器一起在官方模型
  // 就绪后才出现。复刻壳只画中栏，若不预留，换装瞬间列表会被侧栏挤窄（实测 1376→1038）
  // 并整体右移，看起来就是「先一屏通栏列表，侧栏啪一下冒出来」。
  // 这里照官方几何在中栏前留出 288px（300 宽 − 12 负边距 = 中栏实际起点），
  // 底色用官方的 --col-bg-color（亮色 #f7f8fa / 暗色 #222222，随主题自动切换，
  // 不能用写死的 rgb），于是换装前后中栏位置与底色完全一致、不再跳。
  // 只动复刻壳自己的留白，不碰官方任何 DOM。
  var RP_NAVCOL_W = 288;   // 中栏实际起点 = navCol 宽 300 − 其 margin-inline-end:12 的负边距
  function rpBuildShell() {
    var shell = document.createElement('div');
    shell.setAttribute('data-otvz-replica', '1');
    shell.style.cssText = 'margin-top: 63px; position: fixed; inset: 0px; display: flex; background-color: var(--col-bg-color);';
    shell.innerHTML = '<div data-otvz-replica-navcol aria-hidden="true" style="flex: 0 1 auto; width: ' + RP_NAVCOL_W + 'px; min-width: ' + RP_NAVCOL_W + 'px; height: 100%; background-color: var(--col-bg-color);"></div>'
      // height:100% 不能省：只写 overflow:auto 而不给高度，滚动容器会被内容撑开成
      // 「整页滚动」（复刻期能滚出 5 万像素的伪长页）；给了高度才是官方那种列内滚动。
      + '<div data-otvz-replica-scroller style="overflow: auto; flex: 1 1 0px; height: 100%; padding-top: 4px; padding-bottom: 30px; min-width: 420px; background-color: var(--col-bg-color); padding-inline: 10px 40px;">'
      + '<div style="width: 100%;"><div data-otvz-replica-barhost style="width: 100%;"></div>'
      + '<div data-otvz-replica-list style="padding-bottom: 12px; padding-top: 0px;"></div></div></div>';
    rp.shell = shell;
    rp.navColEl = shell.querySelector('[data-otvz-replica-navcol]');
    rp.scroller = shell.querySelector('[data-otvz-replica-scroller]');
    rp.barHost = shell.querySelector('[data-otvz-replica-barhost]');
    rp.listEl = shell.querySelector('[data-otvz-replica-list]');
  }

  // 复刻期怎么「停住」官方那份全量渲染
  // ---------------------------------------------------------------
  // 背景（clone-probe.mjs 实测）：复刻期官方列容器只是 opacity:0，**布局照常**。
  // 于是导航后 0.3s 起主线程就被官方物化 5000+ 行占满——复刻期累计长任务 2095ms、
  // 最长单个 537ms。我的复刻列表只有 175 行，却和它抢同一个线程，所以滚起来就顿。
  //
  // 为什么不能直接 display:none / visibility:hidden（试过，都不能用）：
  //   · display:none —— 容器不再生成盒子，官方分片渲染的 IntersectionObserver
  //     永远判「不相交」，渲染直接停摆，换装时是一片空白；
  //   · visibility:hidden —— 同上，IO 判定不可见，官方渲染永不启动（曾实测 90s
  //     零渲染零报错，极易误判为「抖动」）。
  //
  // 用 `content-visibility:hidden`：**子树整体跳过布局与绘制，但元素自身仍参与渲染
  // 树、仍生成盒子**，所以 IO 照常判相交（实测 35 次渲染推进，与不加时同量级），
  // 而官方那几千行的布局开销被整块跳过。这就是「既能停住、又能被唤醒」的那个点。
  //
  // 唤醒：换装（摘壳）时立刻清掉。另外在复刻期做两道保险——
  //   · 我的复刻页已经画好（rp.rows > 0）→ 立刻还回渲染权。这一刻用户眼前已经有
  //     一页可读内容了，官方接下来怎么抢线程都不影响观感；
  //   · 复刻期超过 RP_HIDE_MAX_MS（默认 6s）→ 无条件还原，绝不把官方渲染压太久。
  //
  // ⚠️ 唤醒条件选错的两次实测（勿重犯）：
  //   · 用 page.on 唤醒 → page.on 依赖补丁测量、测量依赖官方渲染出的行，而我们正把
  //     官方按着 → 循环等待，撑到超时才还权，复刻期被拉到 8.9s；
  //   · 用「官方已物化 RP_HIDE_ROWS 行」唤醒 → 阈值附近正是官方物化最重的一段，
  //     一放权 312ms 大长任务立刻回来（复刻期 1.7s 但峰值回到 312ms）。
  //   正解是「按我自己的就绪状态」唤醒：复刻页 476ms 就画好，按住它几乎零代价，
  //   而官方最重的那一段被完整跳过。
  var RP_HIDE_ROWS = 200;      // 兜底：官方已物化这么多行也放权（rp.rows 异常时的保险）
  var RP_HIDE_MAX_MS = 6000;   // 硬上限：无论如何不压超过 6 秒
  function rpUnhide(why) {
    var el = rp.hidEl;
    rp.hidEl = null;
    if (!el) return;
    el.style.contentVisibility = '';
    try { if (window.__otvz) window.__otvz.replicaHideMs = rpHideEnd(why); } catch (e) { /* 忽略 */ }
  }
  function rpHideEnd(why) {
    var ms = rp.hidStart ? (now() - rp.hidStart) : 0;
    rp.hidStart = 0;
    return { why: why || 'swap', ms: ms };
  }
  function rpHideOfficial() {
    var cad = document.getElementById('contentAreaDiv');
    if (!cad) return;
    var kids = cad.children, i, k;
    for (i = 0; i < kids.length; i++) {
      k = kids[i];
      if (k === rp.shell) continue;
      if (k.style.opacity !== '0') { k.style.opacity = '0'; k.style.pointerEvents = 'none'; }
      if (rp.hidEl !== k) {
        k.style.contentVisibility = 'hidden';
        rp.hidEl = k;
        rp.hidStart = now();
      }
    }
  }

  // 壳的看门狗：官方框架清空 contentAreaDiv 会把壳一起冲掉 → 立即补挂；
  // 官方列容器一出现就藏起来（见上面 rpHideOfficial 的取舍说明）。
  function rpTick() {
    if (!rp.active && !rp.swapped) {
      if (rp.mo) { rp.mo.disconnect(); rp.mo = null; }
      return;
    }
    var cad = document.getElementById('contentAreaDiv');
    if (!cad) return;
    var kids = cad.children, i, k;
    if (!rp.swapped) {
      if (!rp.shell.isConnected) cad.insertBefore(rp.shell, cad.firstChild);
      // 若官方框架把容器整个换过（hidEl 已不在树里）→ 忘掉旧引用，下一轮重新藏
      if (rp.hidEl && !rp.hidEl.isConnected) { rp.hidEl = null; rp.hidStart = 0; }
      rpHideOfficial();
      // 唤醒：我的复刻页画好了就放权（主条件）；另两道兜底（理由见上方注释）
      if (rp.hidEl) {
        if (rp.rows > 0) rpUnhide('replicaReady');
        else if (page.lastRows > 0 && page.lastRows >= RP_HIDE_ROWS) rpUnhide('rows');
        else if (rp.hidStart && now() - rp.hidStart > RP_HIDE_MAX_MS) rpUnhide('timeout');
      }
    } else {
      rpUnhide('swap');
      if (rp.shell && rp.shell.isConnected && rp.shell.parentNode) rp.shell.parentNode.removeChild(rp.shell);
      for (i = 0; i < kids.length; i++) {
        k = kids[i];
        if (k !== rp.shell && k.style && k.style.opacity === '0') { k.style.opacity = ''; k.style.pointerEvents = ''; }
      }
      rp.active = false;
      if (rp.mo) { rp.mo.disconnect(); rp.mo = null; }
      if (rp.timer) { clearInterval(rp.timer); rp.timer = 0; }
    }
  }

  function startReplica() {
    if (rp.active || rp.swapped || killed) return;
    rp.active = true;
    rp.tStart = now();
    rpBuildShell();
    try {
      rp.mo = new MutationObserver(rpTick);
      rp.mo.observe(document.getElementById('contentAreaDiv') || document.body, { childList: true, subtree: false });
    } catch (e) { rp.mo = null; }
    rpTick();
    rp.timer = setInterval(rpTick, 400);   // observer 之外的兜底心跳
    rp.swapT = setTimeout(function () { try { swapReplica(true); } catch (e) { /* 忽略 */ } }, 12000);
    rpLoad();
  }

  function rpDelay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  // 读数据：只走「主键 get」逐个取（root → childIds 树序展开）。
  // 官方分组有两种 groupType：「tabGroup」和「window」（Jt = tabGroup || window），
  // 两者都要渲染；「folder」是目录（原地展开，其子项顶替它的位置）。
  async function rpLoad() {
    var attempt = 0;
    while (rpActive() && attempt < 4) {
      attempt++;
      var db = null;
      try {
        db = await new Promise(function (res, rej) {
          var r = indexedDB.open('onetab', 2);
          r.onsuccess = function () { res(r.result); };
          r.onerror = function () { rej(r.error); };
        });
        var tx = db.transaction('item', 'readonly');
        var store = tx.objectStore('item');
        var getK = function (k) {
          return new Promise(function (res) {
            var r = store.get(k);
            r.onsuccess = function () { res(r.result || null); };
            r.onerror = function () { res(null); };
          });
        };
        var root = await getK('root');
        if (root && root.childIds && root.childIds.length) {
          var size = page.size || 100;
          var html = '', rows = 0, guard = 0;
          // 树序 BFS：root.childIds 即显示顺序；folder 原地展开（其子项顶替它的位置）
          var queue = root.childIds.slice();
          while (queue.length && rows < size + 60 && guard < 600 && rpActive()) {
            var gid = queue.shift();
            guard++;
            var g = await getK(gid);
            if (!g || g.type !== 'group') continue;
            if (g.groupType === 'folder') { queue = (g.childIds || []).concat(queue); continue; }
            var tabs = [], ch = g.childIds || [];
            for (var j = 0; j < ch.length; j++) {
              var t = await getK(ch[j]);
              if (t && t.type === 'tab') tabs.push(t);
            }
            html += rpGroup(g, tabs);
            rows += tabs.length;
          }
          if (rpActive() && rp.listEl) {
            rp.listEl.innerHTML = html;
            rp.rows = rows;
            rp.tRows = now();
          }
          try { db.close(); } catch (_) {}
          return;
        }
        try { db.close(); } catch (_) {}
      } catch (e) { try { if (db) db.close(); } catch (_) {} }
      if (rpActive()) await rpDelay(900);
    }
  }

  // 换装：摘壳 + 恢复官方列可见性 + 尽量把复刻阶段的滚动位置带过去
  function swapReplica(force) {
    if (!rp.active || rp.swapped) return;
    if (!force && (!page.on || page.total <= 0)) return;
    rp.swapped = true;
    rp.scrollerTop = 0;
    try { if (rp.scroller) rp.scrollerTop = rp.scroller.scrollTop || 0; } catch (_) {}
    if (rp.swapT) { clearTimeout(rp.swapT); rp.swapT = 0; }
    rpTick();
    if (rp.scrollerTop > 0) {
      setTimeout(function () {
        try {
          var sc = scroller || findScroller();
          if (sc) sc.scrollTop = rp.scrollerTop;
        } catch (_) {}
      }, 0);
    }
  }

  function destroyReplica() {
    if (rp.swapped) { rp.active = false; return; }
    if (!rp.active) return;
    swapReplica(true);
  }

  function boot() {
    if (!document.body) { setTimeout(boot, 30); return; }

    // 恢复上次选择的每页条数（50/100/200，翻页条下拉框写入）
    try {
      var s = parseInt(localStorage.getItem(PAGE_SIZE_KEY), 10);
      if (s === 50 || s === 100 || s === 200) page.size = s;
    } catch (_) {}

    new MutationObserver(function (muts) {
      // 先遣条被官方框架清空壳元素时冲掉了 → 立即补挂，不等 250ms 静默期
      if (page.early && page.bars && !page.bars[0].bar.isConnected) {
        try { mountPagersEarly(); } catch (e) { /* 忽略 */ }
      }
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes.length || muts[i].removedNodes.length) { schedule(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true });

    window.addEventListener('resize', function () {
      forceFull = true;
      schedule();
    }, { passive: true });

    // 字体加载完会改变行高，届时整体重测一次
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { forceFull = true; schedule(); });
      }
    } catch (_) {}

    installScrollIntoViewGuard();
    // 翻页条要「瞬间出现」：不等任何列表数据，boot 就把条挂进静态壳显示「加载中…」
    // 首屏直出：先搭复刻壳（条随之住进去），再挂条，两步都在 boot 第一毫秒完成
    try { startReplica(); } catch (e) { /* 忽略 */ }
    try { mountPagersEarly(); } catch (e) { /* 忽略 */ }
    schedule();
    setTimeout(function () { if (!built) { try { sync(true); } catch (e) { onError(e); } } }, 3000);

    try {
      window.__otvz = {
        get active() { return active; },
        get groups() { return L ? L.n : 0; },
        get containers() { return conts.length; },
        get rows() { return conts.reduce(function (a, c) { return a + c.n; }, 0); },
        get laidOutRows() { var k = 0; for (var i = 0; i < conts.length; i++) k += Math.max(0, conts[i].p1 - conts[i].p0 + 1); return k; },
        get laidOutGroups() { return L ? Math.max(0, L.p1 - L.p0 + 1) : 0; },
        get hiddenRows() { return document.getElementsByClassName(CLS_ROW).length; },
        get hiddenGroups() { return document.getElementsByClassName(CLS_GRP).length; },
        get domNodes() { return document.getElementsByTagName('*').length; },
        get stats() { return stats; },
        get pageState() { return { on: page.on, page: page.idx + 1, pages: page.pages, size: page.size, total: page.total, loading: page.loading, early: page.early }; },
        get replica() { return rpStatus(); },
        sync: sync, apply: apply, verify: verify, geom: geom, dump: dump, kill: kill,
        setPage: setPage, setPageSize: setPageSize,
      };
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();

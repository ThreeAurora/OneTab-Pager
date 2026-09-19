# OneTab 魔改版（OneTab Performance Patch）

OneTab 存到几千个标签页之后会彻底卡死：**列表页把所有条目一次性塞进 DOM**（5000 条 ≈ 4.2 万个节点），没有虚拟滚动、没有分批渲染。结果是——

- 打开列表页要等十几秒；
- 滚动时每次鼠标命中测试都要遍历整个列表，144Hz 屏掉帧掉到 20% 的帧是忙的；
- 点一个条目恢复到浏览器，页面僵住十几秒。

本仓库是**让 OneTab 重新变流畅的补丁集**。做法是：复制商店版目录 → 加载为本地扩展（开发者模式）→ 在副本上追加我们自己写的 JS/CSS。**不改商店版、不做反编译、不含 OneTab 的任何源码。**

> ⚠️ 本仓库早期版本只发布"一行 CSS 配方"。那个方案已经退役并整体删除——理由见下方「为什么旧的一行 CSS 方案被废弃」。

## 效果（实测，5232 条 / 187 组）

| 场景 | 原生 OneTab | 本补丁 |
|---|---|---|
| 首屏第一行可见 | ~1473 ms | **410–742 ms** |
| 滚动的「忙帧」占比 | 36.7% | **4.1%** |
| 滚动命中测试 p50 | 4.9 ms | **0.4 ms** |
| 点击条目阻塞主线程 | 有可感知停顿 | **0 ms**（长任务数 0） |
| 批量插入 100 条 | 有可感知停顿 | **11.3 ms，阻塞 0 ms** |
| 行高估算误差 | — | **0**（实测 26 个样本全对齐） |

补丁全部在扩展的页面层完成，**界面长相与官版完全一致**——这是我们给自己定的硬约束：用户装完不应该觉得"换了个扩展"。

## 补丁做了什么

四件事，按落地顺序：

### 1. 两层虚拟滚动（组层 + 行层）
`.tabGroup` 与 `.tab` 两层都用 padding 撑高、只渲染视口附近的行。外层的滚动条高度保持真实，滚动手感与官方一致。

### 2. 分页（50 / 100 / 200 条每页）
每页条数记在 `localStorage` 的 `otvzPageSize`；翻页条顶部 + 底部各一条。切片按「官方可见行」（高度 > 0 的行）计数，所以官方自带的搜索/折叠不会让分页名额错位。

### 3. 首屏直出（复刻期）
这是消除"打开就卡"的关键。启动时不等官方渲染，而是：
- 搭一个「官方同款壳」（包装链的内联样式照抄实拍 DOM）；
- 直接读 IndexedDB 复刻第一页（`root.childIds` 的树序 = 屏幕顺序，主键定向 get，约 425 ms 可读）；
- 第一页就绪后摘壳换装。

同时在复刻期**把官方那套全量渲染按住**（详见下节），所以复刻期内主线程不会被官方拖着走。

### 4. 复刻期按住官方渲染（v3.2）
复刻期官方的全量渲染若放任它跑，会在后台吃掉主线程（实测 20 次长任务 / 累计 2095 ms / 单次最长 537 ms），把复刻期拖长、让滚动发涩。

关键手段是 **`content-visibility: hidden`**：

| 手段 | 结果 |
|---|---|
| `display: none` | 元素没有盒子 → `IntersectionObserver` 判不可见 → 官方分片渲染**永久停摆**，换装时一片空白 |
| `visibility: hidden` | 同上。实测 90 秒零渲染、零报错，极易被误判成"抖动" |
| **`content-visibility: hidden`** ✅ | 跳过布局与绘制，但**保留盒子**，`IntersectionObserver` 正常工作 → 官方渲染照常推进，只是不占主线程 |

什么时候放开（唤醒时机）——我们试了三轮，结论有点反直觉：

| 唤醒条件 | 复刻期总长 | 单次最长长任务 | 问题 |
|---|---|---|---|
| 等官方 `page.on` | 8.9 s ❌ | 134 ms | **循环等待**：`page.on` ← 补丁测量 ← 官方渲染，而官方渲染正被我们按住 → 一直等到 6 秒超时 |
| 官方物化了 200 行 | 1.7 s | 312 ms ⚠️ | 该阈值正好落在官方最重的物化阶段 |
| **复刻页自己画好了（`rp.rows > 0`）** ✅ | **1.3 s** | **240 ms** | 复刻页约 0.5 s 就画完，按住它的代价是零 |

> **原则：唤醒要看「我自己就绪没有」，不要看对方的进度——因为对方的进度恰恰是被你按住的那个东西。**

v3.1 → v3.2 的实测对比：

| 指标 | v3.1（只用 opacity 藏） | v3.2 |
|---|---|---|
| 复刻期总长 | 3.0 s | **1.3–2.0 s** |
| 单次最长长任务 | 537 ms | **240 ms** |
| 累计长任务 | 2095 ms | **1507 ms** |

（残留的那 240 ms 发生在**换装之后**——官方被放开后补完自己渲染的收尾。它不是复刻期的问题，v3.1 时期只是被 537 ms 掩盖了。彻底消掉需要动官方渲染器本身，超出补丁范围。）

## 复刻期的小细节

- **组头按钮的「加载中」外观**：复刻期组头的「折页 / 全部还原 / 更多…」会加 `data-otvz-pending="1"`，显示成半透明 + 呼吸动画。这是**纯外观、零副作用**：不拦点击、链接照常可点、复刻 DOM 摘掉时属性自然消失。
  - 为什么不做成真可点？官方组头按钮绑的是**实例**不是 DOM（`Q(k.i,"click",…)` + 内部方法），公开可派发的只有 `clickTabGroupButton` 且**不含 foldButton**；折页还会往 IndexedDB 写 `folded`、改变官方可见性，与「按官方可见行计数」的分页切片规则直接冲突。四条硬冲突详见 [docs/虚拟滚动与分页.md](docs/虚拟滚动与分页.md)。
- **预留 288px 侧栏位**：官方三栏是同时创建的，侧栏不在复刻期。复刻壳里留一个 288px 的占位（背景用 `var(--col-bg-color)`，浅色 `#f7f8fa` / 深色 `#222222`），否则换装瞬间列表会从 0 跳到 288px，观感是"内容被挤窄"。
- **先遣期只挂顶条翻页条**：底部那条在列表容器挂好之前一律不显示，否则空容器里顶底条会叠在一起（出现过"两排翻页按钮"）。

## 快速开始

### 方式 A：一键构建（推荐）

```powershell
# 1. 找到商店版目录，例如 Edge：
#    C:\Users\<你>\AppData\Local\Microsoft\Edge\User Data\Default\Extensions\hoimpam…\<版本号>_0
#    Chrome 则在其 User Data\Default\Extensions 下
# 2. 构建魔改版（自动复制 + 改 manifest + 打补丁）：
.\build_modded.ps1 -SourceDir "C:\…\2.18_0" -TargetDir "…\OneTab-Modded"
# 3. 打开 edge://extensions（或 chrome://extensions）→ 打开「开发人员模式」
#    →「加载解压缩的扩展」→ 选择 TargetDir
```

脚本自动做三件事：
1. 复制商店版目录为副本；
2. 改副本 `manifest.json`：去掉商店 `key`（扩展 ID 由路径生成，与商店版错开，可并存）、去掉 `update_url`、显示名改「OneTab 魔改版」、快捷键改 `Alt+Shift+2`（避开商店版的 `Alt+Shift+1`）；
3. 把补丁追加到副本（幂等，重复运行不会重复打）。

### 方式 B：直接用发布包

从 Releases 下载 `OneTab-Modded-*.zip`，解压后按上面第 3 步加载即可。

### 方式 C：纯手动

1. 从商店装 OneTab，找到安装目录，整体复制一份；
2. 改副本 `manifest.json`：删掉 `"key"` 与 `"update_url"`，改个能认出来的名字，版本号 +1；
3. 把 `onetab.patch.css` 追加到副本 `onetab.css` 末尾；把 `onetab.virtual.js` 放进副本目录，并在 OneTab 的页面里引入（`build_modded.ps1` 会处理引入）；
4. 同方式 A 第 3 步加载。

## 数据迁移（只在你需要在新版里看到原数据时做）

魔改版 ID 与商店版不同，浏览器按扩展 ID 隔离数据，旧数据不会自动出现。两步搬过去：

1. 打开**商店版** OneTab 页面 → F12 → Console → 粘贴运行 `tools/dump_onetab_items.js` → 下载 `onetab-raw-backup-<时间>.json`；
2. 把该 JSON 放进魔改版目录，改名 `onetab-raw-backup.json`，打开**魔改版** OneTab 页面 → F12 → Console → 粘贴运行 `tools/backfill_onetab_items.js` → 刷新后数据全部恢复。

（本质是原样导出 / 写回 IndexedDB 的 `item` / `attr` / `shareUpdate` 三个库，tab、分组、回收站、任务都不丢。）

## 诊断与实测工具

`tools/lab/` 下是一整套基于 CDP 的实测台，用来量化"到底快了多少"，也是这份 README 里所有数字的来源：

| 工具 | 用途 |
|---|---|
| `bench.mjs` | 全量基准（7 阶段：加载 / 状态 / 点击 / 精度 / 插入 / 滚动 A-B / 官方基线） |
| `clone-probe.mjs` | 量复刻期的 DOM 物化与长任务分布 |
| `refresh-probe.mjs` | 刷新复现探针（带复刻采样与卡住现场诊断） |
| `sidebar-probe.mjs` | 复刻期的 pager / 侧栏 / 列表起点时间线 |
| `navwidth-probe.mjs` | 官方侧边栏 box model 实测（改布局前必跑） |
| `navcol-probe.mjs` | 官方三栏出现时机 |
| `idb-probe*.mjs` | 首屏直出的 IndexedDB 读取链路现场诊断 |

跑基准：

```bash
node tools/lab/bench.mjs --label myrun --port 9613 --headless --warmup 6 \
  --phases p0,p6,p4,p8,p7,p12,p9,p11
```

> 两个坑：① 同一个 `--label` 会复用同一个 profile 目录，残留会话会导致 `Session with given id not found`——换 label、换端口、先删 `profile-<label>`。② `p9` 会停用补丁，所以 `p6` / `p12` 必须排在它前面。

## 为什么旧的一行 CSS 方案被废弃

早期版本只发布这一行：

```css
.tab { content-visibility: auto; contain-intrinsic-size: auto 26px; }
```

它在 4396 条上确实把命中测试从 12.25 ms 压到 6.86 ms。但它的**前提**是"官方没有虚拟滚动"——而本补丁现在自己就实现了虚拟滚动，两者叠加会互相打架（我们会主动测量行高，`content-visibility: auto` 会让屏幕外行不产生真实布局）。

而且它治不了核心痛点：**首屏仍然要等官方把几千行全渲染完**。所以现在改用完整的虚拟滚动 + 分页 + 首屏直出，命中测试做到了 0.4 ms，比那一行 CSS 好一个数量级。

## 已知注意事项

- 魔改版与商店版**扩展 ID 不同**、数据不共享，需要搬数据见上面「数据迁移」。
- 补丁依赖官方 DOM 结构（`.tabGroup` / `.tab` / `controlButton` 等）。官方大版本更新后可能需要重新校准，跑一遍 `bench.mjs` 就知道。
- `groupType` 有 `tabGroup` 和 `window` 两种，`folder` 是目录要原地展开——改渲染逻辑时别漏。
- 复刻期（约 1.3–2 s）组头的「全部还原 / 更多… / 折页」长着官方样子但**点不动**，已被「加载中」外观覆盖。

## 许可证

MIT，见 [LICENSE](LICENSE)。OneTab 商标与代码版权归其开发者所有，本项目仅作描述性引用，不含其源码。

---

## English TL;DR

OneTab dumps every saved tab into the DOM upfront (no virtualization): 5,000 items ≈ 42k nodes. Result: a ~10+ second freeze when restoring a tab, a 36.7% busy-frame ratio while scrolling, and a 4.9 ms hit-test p50 against a 6.9 ms frame budget at 144 Hz.

This repo is a **patch set** that makes OneTab smooth again, without touching the store copy or decompiling anything. It adds four things: (1) **two-level virtual scrolling** (group + row); (2) **pagination** (50/100/200 per page, remembered in `localStorage`); (3) **instant first paint** — at boot we render page 1 by reading IndexedDB directly (~425 ms) instead of waiting for the built-in renderer; and (4) **`content-visibility: hidden` to park the built-in renderer** during that first-paint phase. `display:none` / `visibility:hidden` both kill `IntersectionObserver` visibility and permanently stall the built-in chunked renderer — `content-visibility:hidden` skips layout and paint while keeping the box, so the renderer keeps progressing without hogging the main thread. We un-park it as soon as *our own* replica page is ready (not when the built-in renderer reports progress — that's circular, since its progress is exactly what we're holding).

Measured on 5,232 items / 187 groups: first visible row 1473 ms → **410–742 ms**; scroll busy-frame ratio 36.7% → **4.1%**; hit-test p50 4.9 ms → **0.4 ms**; click blocking **0 ms**; 100-row bulk insert **11.3 ms**.

Build it with `build_modded.ps1` (copies the store dir, strips `key`/`update_url`, applies the patch) and load it via `chrome://extensions` → Developer mode → Load unpacked — or grab the ready-made zip from Releases. Patch and tools are MIT; OneTab's own code and branding belong to its developers.

# OneTab 魔改版 · 不卡补丁

官方 OneTab 收藏到几千个标签页之后会变得很卡：打开列表要等十几秒、滚动掉帧，**点一下恢复标签页，整页僵住十几秒**。本补丁让同样的数据量重新流畅起来，**界面与官方一模一样**——装完不应该觉得「换了个扩展」。

## 效果（实测 5,232 条 / 187 组）

| 场景 | 官方原版 | 装补丁后 |
|---|---|---|
| 打开列表页，首行可见 | ~1473 ms | **410–742 ms** |
| 滚动卡顿（忙帧占比） | 36.7% | **4.1%** |
| 点击恢复标签页 | 僵住十几秒 | **几乎瞬开（0 长任务）** |
| 批量新增 100 条 | 可感知停顿 | **11.3 ms** |

## 功能

- **虚拟滚动**：只渲染屏幕上看得见的行，几千条和几百条一样轻快。滚动条长度、滚动位置与官方完全一致，手感不变。
- **分页**：每页 50 / 100 / 200 条可选（选择会被记住），列表顶部和底部各一条翻页条。官方自带的搜索照常使用——搜索或折叠藏起来的条目不会占页名额。
- **首屏直出**：打开页面不再干等官方渲染，补丁直接读数据先把第一页画出来——约 0.4 秒就能看、能点。
- **外观零差异**：行、分组、图标、亮暗主题都与官方一致；条目少到一页装得下时翻页条自动消失，与官方原版没有区别。

## 安装

### 方式一：用发布包（推荐）

1. 到 [Releases](https://github.com/ThreeAurora/OneTab-Performance-Patch/releases) 下载 `OneTab-Modded-*.zip`，解压到任意一个固定的目录（装好后不要删或移动它）；
2. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`），打开右上角的「开发人员模式」；
3. 点「加载解压缩的扩展」，选择解压出来的目录（含 `manifest.json` 的那一层）。

装好后用 **`Alt+Shift+2`** 打开魔改版页面（商店版是 `Alt+Shift+1`）。魔改版扩展 ID 与商店版不同，**两者可以并存**。

### 方式二：从商店版自己构建

```powershell
# 1) 复制商店版并改造：独立 ID、新名字、新快捷键
.\build_modded.ps1 -SourceDir "C:\…\Edge\User Data\Default\Extensions\hoimpam…\2.18_1" -TargetDir "D:\OneTab-Modded"
# 2) 打补丁（CSS + JS）；官方更新后只需重跑这一条
.\apply_patch.ps1 -TargetDir "D:\OneTab-Modded"
```

再按方式一的第 2、3 步加载。`apply_patch.ps1 -TargetDir "D:\OneTab-Modded" -Disable` 可把补丁整体摘掉、还原成官方原状（再跑一次同样的命令即恢复）。

商店版目录在 `…\User Data\Default\Extensions\hoimpamkkoehapgenciaoajfkfkpgfop\` 下带版本号的那一层（就是指含 `manifest.json` 的目录），Edge 与 Chrome 同理。不想用脚本的话，手动做脚本里的几件事：复制商店版目录 → 改副本 `manifest.json`（删 `key` 与 `update_url`，改名字、版本号 +1）→ 把 `onetab.patch.css` 追加到副本 `onetab.css` 末尾 → 把 `onetab.virtual.js` 放进副本并在 `onetab.html` 里挂 `<script>`。

## 把旧数据搬过来（可选）

魔改版与商店版的扩展 ID 不同，浏览器按 ID 隔离数据，旧数据不会自动出现。要搬的话两步：

1. 打开**商店版** OneTab 页面 → `F12` → Console → 粘贴运行 [`tools/dump_onetab_items.js`](tools/dump_onetab_items.js)，下载 `onetab-raw-backup-<时间>.json`；
2. 把这个 JSON 放进**魔改版**目录、改名 `onetab-raw-backup.json`，打开魔改版页面 → `F12` → Console → 粘贴运行 [`tools/backfill_onetab_items.js`](tools/backfill_onetab_items.js) → 刷新，数据全部回来。

标签页、分组、回收站、任务都不丢。

## 常见问题

- **装好了没感觉变快？** 条目数上千差别才明显；再确认打开的是魔改版页面（`Alt+Shift+2` 或点魔改版图标），而不是商店版。
- **刚打开的一两秒里，「全部还原 / 更多… / 折页」点不动？** 正常现象：这几秒页面正在从存储里读数据，按钮显示成半透明的「加载中」样子，稍等即可用（链接不受影响）。
- **会不会弄坏我的数据、影响商店版？** 不会。补丁只改页面显示层，不碰官方代码与数据格式；两个版本的数据各自独立。
- **官方升级了怎么办？** 魔改版不跟随官方自动更新。想升级：把数据搬过去 → 对新版目录重跑方式二的两个脚本 → 在扩展页点「重新加载」（或直接下载新的 Release）。

## 技术细节

补丁的实现过程与实测数据见 [docs/虚拟滚动与分页.md](docs/虚拟滚动与分页.md) 与 [docs/实测数据与工具.md](docs/实测数据与工具.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。OneTab 商标与代码版权归其开发者所有，本仓库只发布补丁代码、不含 OneTab 源码。

---

## English

Official OneTab renders every saved tab up front (5,000 items ≈ 42k DOM nodes): the list takes seconds to open, drops frames while scrolling, and freezes the page when restoring a tab. This patch keeps the UI identical while rendering only what is on screen, adds pagination (50 / 100 / 200 per page) and paints page 1 straight from IndexedDB before the built-in renderer finishes (~0.4 s).

**Install** — download `OneTab-Modded-*.zip` from [Releases](https://github.com/ThreeAurora/OneTab-Performance-Patch/releases), unzip it somewhere permanent, then `chrome://extensions` → Developer mode → Load unpacked. Or build from your store copy with `build_modded.ps1` + `apply_patch.ps1`. MIT licensed; OneTab's code and branding belong to its developers.

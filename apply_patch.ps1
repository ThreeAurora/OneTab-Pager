<#
apply_patch.ps1 —— 给一个 OneTab 扩展目录加上「翻页版」内容

补两层：
  1. onetab.css 追加补丁样式（含兜底的 content-visibility 与虚拟滚动用的 .otvz-off）
  2. 把 onetab.virtual.js 复制进去，并在 onetab.html 里挂上 <script>

幂等：重复运行不会重复追加 / 重复插标签。
适用：任何「商店版副本」或已经改造过的目录（官方更新后重跑一次即可跟进）。

用法：
  .\apply_patch.ps1 -TargetDir "E:\CCSpace\projects\2026\09\OneTab性能诊断\OneTab-patched-unpacked"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$TargetDir,
    # 把补丁整体停用，恢复成「官方原状」，用于跑真基线做对照。再用默认参数跑一次即可恢复。
    [switch]$Disable
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$TargetDir = (Resolve-Path -LiteralPath $TargetDir).Path
foreach ($f in 'manifest.json', 'onetab.html', 'onetab.css') {
    if (-not (Test-Path (Join-Path $TargetDir $f))) {
        throw "该目录下没有 $f，看起来不是 OneTab 扩展根目录：$TargetDir"
    }
}

$styleSrc = Join-Path $PSScriptRoot 'onetab.patch.css'
$scriptSrc = Join-Path $PSScriptRoot 'onetab.virtual.js'
if (-not (Test-Path $styleSrc))  { throw "找不到 $styleSrc" }
if (-not (Test-Path $scriptSrc)) { throw "找不到 $scriptSrc" }

$cssPath = Join-Path $TargetDir 'onetab.css'
$htmlPath = Join-Path $TargetDir 'onetab.html'
$beginTag = '/* ===== OneTab 不卡补丁 BEGIN ====='
$endTag = '/* ===== OneTab 不卡补丁 END ===== */'

# ---- 0) 停用：把补丁整体摘掉，还原成官方原状 ----
if ($Disable) {
    $cur = [System.IO.File]::ReadAllText($cssPath)
    $p1 = $cur.IndexOf($beginTag)
    if ($p1 -ge 0) {
        $p2 = $cur.IndexOf($endTag, $p1)
        if ($p2 -lt 0) { throw "onetab.css 有 BEGIN 标记却找不到 END 标记，请先手工检查。" }
        $p2 = $p2 + $endTag.Length
        $nl = $cur.IndexOf("`n", $p2); if ($nl -ge 0) { $p2 = $nl + 1 }
        $cur = $cur.Substring(0, $p1).TrimEnd() + "`r`n"
        [System.IO.File]::WriteAllText($cssPath, $cur, $utf8NoBom)
        Write-Host "[1/2] onetab.css：补丁段已摘除（恢复官方样式）"
    } else {
        Write-Host "[1/2] onetab.css：本来就没有补丁段"
    }

    $html = [System.IO.File]::ReadAllText($htmlPath)
    if ($html -match '<script\s+src="onetab\.virtual\.js"') {
        $html = [regex]::Replace($html, '(?m)^(\s*)<script\s+src="onetab\.virtual\.js"></script>[ \t]*\r?$',
            '$1<!-- baseline-mode: onetab.virtual.js 已停用 -->')
        [System.IO.File]::WriteAllText($htmlPath, $html, $utf8NoBom)
        Write-Host "[2/2] onetab.html：脚本已停用"
    } else {
        Write-Host "[2/2] onetab.html：脚本本来就没挂"
    }

    Write-Host ''
    Write-Host "补丁已停用（官方原状）：$TargetDir"
    Write-Host '跑完基线后，用不带 -Disable 的同一命令即可恢复。'
    exit 0
}

# ---- 1) CSS ----
# 用 BEGIN 标记定位补丁段：从 BEGIN 开始直到文件末尾整段换掉。
# 补丁段永远在文件尾部，所以「切到末尾」既简单又不会误伤官方样式。
$cur = [System.IO.File]::ReadAllText($cssPath)
$newBlock = [System.IO.File]::ReadAllText($styleSrc).TrimEnd()
$p1 = $cur.IndexOf($beginTag)
if ($p1 -ge 0) {
    $cur = $cur.Substring(0, $p1).TrimEnd()
    [System.IO.File]::WriteAllText($cssPath, $cur + "`r`n`r`n" + $newBlock + "`r`n", $utf8NoBom)
    Write-Host "[1/3] onetab.css：补丁段已更新为最新版"
} elseif ($cur -match 'otvz|不卡补丁') {
    # 有过旧版痕迹但找不到 BEGIN 标记 —— 旧格式的补丁段没带结束标记，无法安全整段替换。
    # 这种情况必须人工清理一次，否则会留下半截注释残渣（append 三次就会有三段渣）。
    throw "onetab.css 里存在旧版补丁痕迹但缺少 '$beginTag' 标记，请先手工清理旧补丁段再重跑。"
} else {
    [System.IO.File]::AppendAllText($cssPath, "`r`n`r`n" + $newBlock + "`r`n", $utf8NoBom)
    Write-Host "[1/3] onetab.css：补丁段已追加"
}

# ---- 2) JS ----
$dstJs = Join-Path $TargetDir 'onetab.virtual.js'
Copy-Item -LiteralPath $scriptSrc -Destination $dstJs -Force
Write-Host "[2/3] onetab.virtual.js 已复制（$((Get-Item $dstJs).Length) 字节）"

# ---- 3) 在 onetab.html 里挂 script ----
# 只认「未被注释的」脚本标签，这样 -Disable 留下的注释不会被误判成已挂。
$html = [System.IO.File]::ReadAllText($htmlPath)
if ($html -match '<script\s+src="onetab\.virtual\.js"') {
    Write-Host "[3/3] onetab.html：脚本标签已存在，跳过"
} else {
    $tag = '  <script src="onetab.virtual.js"></script>'
    if ($html -match '(?m)^\s*<!--\s*baseline-mode:.*?-->[ \t]*\r?$') {
        # 之前被 -Disable 注释过，原位恢复
        $html = [regex]::Replace($html, '(?m)^\s*<!--\s*baseline-mode:.*?-->[ \t]*\r?$', $tag, 1)
    } elseif ($html -match '(?i)</body>') {
        $html = [regex]::Replace($html, '(?i)</body>', "$tag`r`n</body>", 1)
    } else {
        $html = $html.TrimEnd() + "`r`n$tag`r`n"
    }
    [System.IO.File]::WriteAllText($htmlPath, $html, $utf8NoBom)
    Write-Host "[3/3] onetab.html：脚本标签已插入"
}

Write-Host ''
Write-Host "补丁完成：$TargetDir"
Write-Host '下一步：edge://extensions → 找到该扩展 → 点「重新加载」。'

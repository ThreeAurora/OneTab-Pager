# build_modded.ps1 —— 把商店版 OneTab 目录一键变成「翻页版」（翻页 + 按需渲染）
# 用法：
#   .\build_modded.ps1 -SourceDir "C:\Users\<你>\AppData\Local\Microsoft\Edge\User Data\Default\Extensions\hoimpamkkoehapgenciaoajfkfkpgfop\2.18_0"
#   .\build_modded.ps1 -SourceDir "..." -TargetDir "D:\My\OneTab-Pager" -DisplayName "OneTab 翻页版"
# 或直接双击运行，按提示把商店版目录路径粘贴进来。
[CmdletBinding()]
param(
    [string]$SourceDir,
    [string]$TargetDir = (Join-Path $PSScriptRoot 'output\OneTab-Pager'),
    [string]$DisplayName = 'OneTab 翻页版'
)

$ErrorActionPreference = 'Stop'

if (-not $SourceDir) {
    $SourceDir = Read-Host '请输入商店版 OneTab 目录的完整路径（含 manifest.json 的那一层）'
}
if (-not (Test-Path $SourceDir))    { Write-Error "找不到源目录: $SourceDir" }
if (-not (Test-Path (Join-Path $SourceDir 'manifest.json'))) { Write-Error "该目录下没有 manifest.json，不是扩展根目录：$SourceDir" }
if (-not (Test-Path (Join-Path $SourceDir 'onetab.css')))    { Write-Error "该目录下没有 onetab.css，不是 OneTab 目录：$SourceDir" }

# 1) 整个复制
if (Test-Path $TargetDir) { Write-Warning "目标目录已存在，将覆盖其中被改动的文件：$TargetDir" }
robocopy $SourceDir $TargetDir /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy 复制失败（code=$LASTEXITCODE）" }
Write-Host "[1/3] 已复制到 $TargetDir"

# 2) 修改 manifest：去掉商店 key / update_url（扩展 ID 变为路径哈希，与商店版错开），
#    改名、版本 +1、快捷键换成 Alt+Shift+2（避开商店版的 Alt+Shift+1）
$mText = [System.IO.File]::ReadAllText((Join-Path $TargetDir 'manifest.json'))
$mText = $mText -replace '(?m)^[ \t]*"key"[ \t]*:.*\r?\n', ''
$mText = $mText -replace '(?m)^[ \t]*"update_url"[ \t]*:.*\r?\n', ''
$mText = $mText -replace '("name"[ \t]*:[ \t]*)"[^"]*"', ('$1"' + $DisplayName + '"')
$mText = $mText -replace '("version"[ \t]*:[ \t]*)"[^"]*"', '"$1"2.18.1"'
$mText = $mText -replace 'Alt\+Shift\+1', 'Alt+Shift+2'
[System.IO.File]::WriteAllText((Join-Path $TargetDir 'manifest.json'), $mText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[2/3] manifest 已调整（独立 ID / 新名字 / Alt+Shift+2）"

# 3) 追加性能补丁（幂等：已含补丁则跳过）
$css = Join-Path $TargetDir 'onetab.css'
$patch = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'onetab.patch.css'))
$cur = [System.IO.File]::ReadAllText($css)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
if ($cur.Contains('OneTab 不卡补丁')) {
    Write-Host "[3/3] $css 已含补丁，跳过。"
} else {
    [System.IO.File]::AppendAllText($css, "`r`n`r`n" + $patch.TrimEnd() + "`r`n", $utf8NoBom)
    Write-Host "[3/3] 补丁已追加。"
}

Write-Host ""
Write-Host "翻页版已生成: $TargetDir"
Write-Host "下一步：edge://extensions（或 chrome://extensions）→ 打开「开发人员模式」→「加载解压缩的扩展」→ 选择该目录。"
Write-Host "首次使用请在商店版里先运行 tools/dump_onetab_items.js 导出数据，装好后再用 backfill_onetab_items.js 导入（见 README）。"
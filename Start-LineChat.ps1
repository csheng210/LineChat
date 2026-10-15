# Start-LineChat.ps1 - 啟動 LineChat: 後端 LineChatAPI(讀, uvicorn) -> 動作後端 LineChatActions(Node/Playwright, 送訊) -> 前端 LineChatWeb(vite)
# 啟動設定一律以各專案目錄下的 .env 為準(端口/資料目錄等); 命令列參數僅作為 .env 缺值時的備援覆寫。
# 用法: 於 LineChat 目錄執行  .\Start-LineChat.ps1   或直接雙擊 Start-LineChat.cmd
# 兩個服務各開一個獨立視窗顯示 log; 要關開直接關那個視窗即可。
param(
  [int]$ApiPort = 0,
  [int]$ActionsPort = 0,
  [int]$WebPort = 0
)
$ErrorActionPreference = 'Stop'
$root       = $PSScriptRoot
$apiDir     = Join-Path $root 'LineChatAPI'
$webDir     = Join-Path $root 'LineChatWeb'
$actionsDir = Join-Path $root 'LineChatActions'
$py         = Join-Path $apiDir '.venv\Scripts\python.exe'

$apiEnv     = Join-Path $apiDir     '.env'
$actionsEnv = Join-Path $actionsDir '.env'
$webEnv     = Join-Path $webDir     '.env'

# 從 .env 檔讀取某個 key 的值(忽略註解/export 前綴/前後引號); 找不到回 $null
function Get-EnvValue([string]$path, [string]$key) {
  if (-not (Test-Path $path)) { return $null }
  foreach ($line in (Get-Content $path)) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $t = $t -replace '^export\s+', ''
    $idx = $t.IndexOf('=')
    if ($idx -lt 1) { continue }
    if ($t.Substring(0, $idx).Trim() -ne $key) { continue }
    $v = $t.Substring($idx + 1).Trim()
    if ($v.Length -ge 2 -and ((($v[0] -eq '"' -and $v[-1] -eq '"')) -or (($v[0] -eq "'" -and $v[-1] -eq "'")))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    return $v
  }
  return $null
}

# 端口優先序: 命令列參數 > .env > 硬預設
function Resolve-Port([int]$paramPort, [string]$envPath, [string]$envKey, [int]$fallback) {
  if ($paramPort -gt 0) { return $paramPort }
  $v = Get-EnvValue $envPath $envKey
  if ($v -and $v -match '^\d+$') { return [int]$v }
  return $fallback
}

$ApiPort     = Resolve-Port $ApiPort     $apiEnv     'LINE_CHAT_API_PORT' 8201
$ActionsPort = Resolve-Port $ActionsPort $actionsEnv 'ACTIONS_PORT'       8202
$WebPort     = Resolve-Port $WebPort     $webEnv     'VITE_DEV_PORT'      8200

# 後端資料目錄: 以 LineChatAPI/.env 為準(缺值則退回 repo 根 Line-Data)
$chatDir  = Get-EnvValue $apiEnv 'LINE_CHAT_API_CHAT_DIR'
$mediaDir = Get-EnvValue $apiEnv 'LINE_CHAT_API_MEDIA_DIR'
if (-not $chatDir)  { $chatDir  = Join-Path $root 'Line-Data\chat_history' }
if (-not $mediaDir) { $mediaDir = Join-Path $root 'Line-Data\chat_media' }

Write-Host "設定來源: API=$ApiPort (LineChatAPI/.env), Actions=$ActionsPort (LineChatActions/.env), Web=$WebPort (LineChatWeb/.env)" -ForegroundColor DarkGray

if (-not (Test-Path $py)) {
  Write-Host "找不到後端 venv: $py" -ForegroundColor Red
  Write-Host '請先建立: cd LineChatAPI; python -m venv .venv; .venv\Scripts\python.exe -m pip install -r requirements.txt' -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path (Join-Path $webDir 'node_modules'))) {
  Write-Host '前端尚未安裝依賴, 請先執行: cd LineChatWeb; npm install' -ForegroundColor Red
  exit 1
}

# 用 Get-NetTCPConnection 權威檢測监聽中的 port(含 IPv4/IPv6; vite 常只監聽 [::1])
function Test-Port([int]$port) {
  try {
    $l = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
    return [bool]$l
  } catch { return $false }
}

# 從 start 往後找第一個空閒 port
function Find-FreePort([int]$start, [int]$span = 30) {
  for ($p = $start; $p -lt ($start + $span); $p++) {
    if (-not (Test-Port $p)) { return $p }
  }
  return $null
}

# ---- 1) 後端 ----
$apiRunning = $false
if (Test-Port $ApiPort) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$ApiPort/api/health" -TimeoutSec 3
    if ($h.status -eq 'ok') { $apiRunning = $true }
  } catch { }
  if ($apiRunning) {
    Write-Host "後端已在執行 (port $ApiPort), 略過啟動" -ForegroundColor Yellow
  } else {
    Write-Host "後端 port $ApiPort 已被其他程式佔用, 無法啟動。請釋放該 port 或改 LineChatAPI/.env 的 LINE_CHAT_API_PORT(或用 -ApiPort 指定)。" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "啟動後端 LineChatAPI (port $ApiPort)..." -ForegroundColor Cyan
  Start-Process powershell -WorkingDirectory $apiDir -ArgumentList @(
    '-NoExit', '-NoProfile', '-Command',
    "`$host.UI.RawUI.WindowTitle='LineChatAPI'; `$env:LINE_CHAT_API_CHAT_DIR='$chatDir'; `$env:LINE_CHAT_API_MEDIA_DIR='$mediaDir'; `$env:LINE_CHAT_API_PORT='$ApiPort'; & '$py' -m uvicorn main:app --host 127.0.0.1 --port $ApiPort --app-dir '$apiDir'"
  ) | Out-Null
}

# 等 health check 就緒(最多 45 秒)
$healthy = $false
$apiInfo = $null
$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  try {
    $apiInfo = Invoke-RestMethod "http://127.0.0.1:$ApiPort/api/health" -TimeoutSec 3
    if ($apiInfo.status -eq 'ok') { $healthy = $true; break }
  } catch { Start-Sleep -Milliseconds 700 }
}
if (-not $healthy) {
  Write-Host '後端 45 秒內未就緒, 請看 LineChatAPI 視窗的錯誡訊息; 前端暫停啟動。' -ForegroundColor Red
  exit 1
}
Write-Host "後端就緒: http://127.0.0.1:$ApiPort (chat_history: $($apiInfo.chat_history_dir))" -ForegroundColor Green

# ---- 1.5) 瀏覽器動作後端 LineChatActions (Node + Playwright, port $ActionsPort) ----
$actionsFm = Join-Path $actionsDir 'node_modules\fastify'
$actionsPw = Join-Path $actionsDir 'node_modules\playwright'
if (-not (Test-Path $actionsFm) -or -not (Test-Path $actionsPw)) {
  Write-Host '未偵測到 LineChatActions 依賴(fastify/playwright), 送訊功能不會啟動。請先: cd LineChatActions; npm install' -ForegroundColor Yellow
} elseif (Test-Port $ActionsPort) {
  $aRunning = $false
  try { $ah = Invoke-RestMethod "http://127.0.0.1:$ActionsPort/health" -TimeoutSec 3; if ($ah.ok) { $aRunning = $true } } catch { }
  if ($aRunning) { Write-Host "LineChatActions 已在執行 (port $ActionsPort), 略過啟動" -ForegroundColor Yellow }
  else { Write-Host "LineChatActions port $ActionsPort 被其他程式佔用, 送訊暫不可用。" -ForegroundColor Red }
} else {
  Write-Host "啟動 LineChatActions (port $ActionsPort)..." -ForegroundColor Cyan
  Start-Process cmd -WorkingDirectory $actionsDir -ArgumentList @(
    '/k', "title LineChatActions && set ACTIONS_PORT=$ActionsPort&& npm start"
  ) | Out-Null
  $aDeadline = (Get-Date).AddSeconds(25)
  $aReady = $false
  while ((Get-Date) -lt $aDeadline) {
    try { $ah = Invoke-RestMethod "http://127.0.0.1:$ActionsPort/health" -TimeoutSec 2; if ($ah.ok) { $aReady = $true; break } }
    catch { Start-Sleep -Milliseconds 500 }
  }
  if ($aReady) { Write-Host "LineChatActions 就緒: http://127.0.0.1:$ActionsPort" -ForegroundColor Green }
  else { Write-Host "LineChatActions 25 秒內未就緒, 請看其視窗; 送訊可能暫時不可用。" -ForegroundColor Yellow }
}

# ---- 2) 前端 ----
# 若 $WebPort 被佔(可能是別的 vite), 自動往後找空閒 port 並用 --strictPort 鎖定
$actualWebPort = $WebPort
if (Test-Port $WebPort) {
  $free = Find-FreePort ($WebPort + 1)
  if ($null -eq $free) {
    Write-Host "前端 port $WebPort 被佔用且後續端口也滿, 無法啟動。" -ForegroundColor Red
    exit 1
  }
  Write-Host "前端 port $WebPort 已被佔用, 改用空閒 port $free" -ForegroundColor Yellow
  $actualWebPort = $free
}
Write-Host "啟動前端 LineChatWeb (port $actualWebPort)..." -ForegroundColor Cyan
Start-Process cmd -WorkingDirectory $webDir -ArgumentList @(
  '/k', "title LineChatWeb && set VITE_DEV_PORT=$actualWebPort&& npm run dev -- --port $actualWebPort --strictPort"
) | Out-Null

# 等前端起來(最多 90 秒), 完成後自動開瀏覽器
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline -and -not (Test-Port $actualWebPort)) { Start-Sleep -Milliseconds 700 }
if (Test-Port $actualWebPort) {
  Write-Host "前端就緒: http://localhost:$actualWebPort" -ForegroundColor Green
  Start-Process "http://localhost:$actualWebPort"
} else {
  Write-Host "前端 90 秒內未就緒, 請看 LineChatWeb 視窗訊息。" -ForegroundColor Red
  exit 1
}

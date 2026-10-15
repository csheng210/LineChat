# Stop-LineChat.ps1 - 停止 Start-LineChat.ps1 啟動的所有服務並關閉其終端視窗:
#   LineChatAPI(uvicorn) / LineChatActions(node) / LineChatWeb(vite) / LineChatSync(python 常駐)。
# 用法: 於 LineChat 目錄執行  .\Stop-LineChat.ps1   或雙擊 Stop-LineChat.cmd
# 清理策略(多重兜底, 一併關閉承載服務的終端視窗):
#   (1) 依視窗標題(開頭 LineChat)殺整棵程序樹  (2) 依命令行殺承載服務的 cmd/powershell 終端
#   (3) 依監聽端口殺 owning 程序樹            (4) 依命令行殺 LineChatSync(python, 無 port)
param(
  [int]$ApiPort = 0,
  [int]$ActionsPort = 0,
  [int]$WebPort = 0
)
$ErrorActionPreference = 'Continue'
$root       = $PSScriptRoot
$apiDir     = Join-Path $root 'LineChatAPI'
$webDir     = Join-Path $root 'LineChatWeb'
$actionsDir = Join-Path $root 'LineChatActions'
$syncDir    = Join-Path $root 'LineChatSync'

# 從 .env 讀 key(忽略註解/export/引號)
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
function Resolve-Port([int]$paramPort, [string]$envPath, [string]$envKey, [int]$fallback) {
  if ($paramPort -gt 0) { return $paramPort }
  $v = Get-EnvValue $envPath $envKey
  if ($v -and $v -match '^\d+$') { return [int]$v }
  return $fallback
}
$ApiPort     = Resolve-Port $ApiPort     (Join-Path $apiDir '.env')     'LINE_CHAT_API_PORT' 8201
$ActionsPort = Resolve-Port $ActionsPort (Join-Path $actionsDir '.env') 'ACTIONS_PORT'       8202
$WebPort     = Resolve-Port $WebPort     (Join-Path $webDir '.env')     'VITE_DEV_PORT'      8200

# 殺整棵程序樹(含承載服務的終端視窗與其 node/python 子程序)
function Stop-Tree([int]$procId) {
  if ($procId -le 0) { return }
  & taskkill /PID $procId /T /F 2>$null | Out-Null
}

$killed = New-Object System.Collections.Generic.HashSet[int]
function Kill-Once([int]$procId, [string]$why) {
  if ($procId -le 0) { return }
  if ($killed.Add($procId)) {
    Write-Host "  殺 PID=$procId ($why)" -ForegroundColor DarkGray
    Stop-Tree $procId
  }
}

Write-Host "停止 LineChat 服務並關閉終端 (API=$ApiPort, Actions=$ActionsPort, Web=$WebPort)..." -ForegroundColor Cyan

# (1) 依視窗標題殺: 開頭為 LineChat 的終端視窗(API/Actions/Web/Sync 四個)
foreach ($proc in (Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like 'LineChat*' })) {
  Kill-Once $proc.Id "標題=$($proc.MainWindowTitle)"
}

# (2) 依命令行殺承載服務的 cmd/powershell 終端(標題比對不到時的兜底, 一併關閉其視窗)
try {
  $hosts = Get-CimInstance Win32_Process -Filter "Name='cmd.exe' OR Name='powershell.exe'" -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -and (
        $_.CommandLine -like '*LineChatAPI*' -or $_.CommandLine -like '*LineChatActions*' -or
        $_.CommandLine -like '*LineChatWeb*' -or $_.CommandLine -like '*LineChatSync*'
      )
    }
  foreach ($h in $hosts) { Kill-Once ([int]$h.ProcessId) '命令行=服務終端' }
} catch { }

# (3) 依監聽端口殺 owning 程序(API/Actions/Web 各自綁定 port)
foreach ($port in @($ApiPort, $ActionsPort, $WebPort)) {
  try {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
    foreach ($c in $conns) { Kill-Once ([int]$c.OwningProcess) "端口=$port" }
  } catch { }
}

# (4) 依命令行殺 LineChatSync(無 port, 靠命令行比對 python main.py)
try {
  $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*LineChatSync*main.py*" }
  foreach ($p in $procs) { Kill-Once ([int]$p.ProcessId) 'LineChatSync' }
} catch { }

# 收尾: 確認端口已釋放
Start-Sleep -Milliseconds 500
$remain = @()
foreach ($port in @($ApiPort, $ActionsPort, $WebPort)) {
  try { if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop) { $remain += $port } } catch { }
}
if ($remain.Count -eq 0) {
  Write-Host '所有服務與終端已停止, 端口全數釋放。' -ForegroundColor Green
} else {
  Write-Host ("以下端口仍被監聽(可能非本專案程序, 未強殺): " + ($remain -join ', ')) -ForegroundColor Yellow
}


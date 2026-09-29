# ops/stop-runner-tree.ps1 — **이 러너 폴더의** 러너 프로세스 트리만 종료하고, 남은 수를 확인해 알린다.
# 왜: Stop-ScheduledTask 는 자식(run-night · auto-story-pipeline · claude/codex 워커)을 죽이지 못한다.
# 대상: 명령줄에 **러너 폴더의 전체 경로**가 들어 있는 프로세스(예약작업의 숨김 기동 래퍼 · 그 경로로 띄운 node)와 그 모든 자손.
#       폴더 이름만 같은 다른 프로젝트의 러너는 건드리지 않는다. 이 스크립트 자신과 그 조상(부른 셸)은 제외한다.
# 사용: powershell -File stop-runner-tree.ps1 -RunnerDir C:\path\to\runner
# 출력 마지막 두 줄: killed=<종료한 수>  remaining=<종료 뒤에도 남은 수> — 부르는 쪽은 remaining=0 을 확인한다.
#       -LockFile <상태 폴더>\runner.lock 을 주면 거기 적힌 pid(러너 본체)도 뿌리로 삼는다 — 래퍼가 먼저 죽어 본체가 고아가 된 경우 대비.
# 뿌리 조건(둘 다): 이름이 cmd·powershell·pwsh·node 중 하나 · 명령줄에 러너 경로 **와** 러너 실행 파일 이름이 함께 있다.
#   → 러너 폴더를 들여다보는 표시기·감시 셸(bash · 읽기 전용 조회)은 잡지 않는다.
param([Parameter(Mandatory = $true)][string]$RunnerDir, [string]$LockFile = '')
$RootNames = @('cmd.exe', 'powershell.exe', 'pwsh.exe', 'node.exe')
$RootMarks = 'run-night\.mjs|auto-story-pipeline|finish-stories\.mjs|watchdog\.mjs'

function Norm([string]$s) { return ($s -replace '/', '\').TrimEnd('\').ToLowerInvariant() }
$target = Norm $RunnerDir
if ($target.Length -lt 4) { "refuse: RunnerDir too short"; "killed=0"; "remaining=-1"; exit 2 }

function Get-Tree {
  $all = Get-CimInstance Win32_Process
  $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
  # 자신과 조상은 제외
  $skip = New-Object System.Collections.Generic.HashSet[int]
  $cur = [int]$PID
  while ($cur -gt 0 -and $byId.ContainsKey($cur) -and -not $skip.Contains($cur)) { [void]$skip.Add($cur); $cur = [int]$byId[$cur].ParentProcessId }
  $ids = New-Object System.Collections.Generic.HashSet[int]
  if ($LockFile -and (Test-Path -LiteralPath $LockFile)) {
    try {
      $lp = [int]((Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json).pid)
      if ($lp -gt 0 -and $byId.ContainsKey($lp) -and $byId[$lp].Name -eq 'node.exe' -and -not $skip.Contains($lp)) { [void]$ids.Add($lp) }
    } catch { }
  }
  foreach ($p in $all) {
    if ($skip.Contains([int]$p.ProcessId) -or -not $p.CommandLine) { continue }
    if ($RootNames -notcontains $p.Name.ToLowerInvariant()) { continue }
    if ([string]$p.CommandLine -notmatch $RootMarks) { continue }
    $cl = Norm ([string]$p.CommandLine)
    # 경로 뒤가 구분자·따옴표·공백·끝이어야 한다(…\runner 와 …\runner-2 를 가른다)
    $i = $cl.IndexOf($target)
    if ($i -lt 0) { continue }
    $next = if ($i + $target.Length -lt $cl.Length) { $cl[$i + $target.Length] } else { ' ' }
    if ('\" '' &'.IndexOf($next) -lt 0) { continue }
    [void]$ids.Add([int]$p.ProcessId)
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($p in $all) {
      $id = [int]$p.ProcessId
      if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains($id) -and -not $skip.Contains($id)) { [void]$ids.Add($id); $changed = $true }
    }
  }
  return ($all | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.Name -ne 'conhost.exe' } | Sort-Object ProcessId)
}

$victims = @(Get-Tree)
foreach ($v in $victims) { "kill $($v.ProcessId) $($v.Name)" }
foreach ($v in $victims) { try { Stop-Process -Id $v.ProcessId -Force -ErrorAction Stop } catch { "fail $($v.ProcessId): $($_.Exception.Message)" } }
Start-Sleep -Seconds 3
$left = @(Get-Tree)
foreach ($v in $left) { "left $($v.ProcessId) $($v.Name)" }
"killed=$($victims.Count)"
"remaining=$($left.Count)"

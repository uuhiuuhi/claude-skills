# ops/stop-runner-tree.ps1 — 러너 프로세스 트리 종료.
# 왜: Stop-ScheduledTask 는 자식(run-night · auto-story-pipeline · claude/codex 워커)을 죽이지 못한다.
# 대상: 명령줄에 run-night.mjs / auto-story-pipeline 이 있거나 러너 폴더 이름이 들어 있는 node 와 그 모든 자손.
# 사용: powershell -File stop-runner-tree.ps1 -RunnerDir C:\path\to\runner
param([Parameter(Mandatory = $true)][string]$RunnerDir)
$leaf = [regex]::Escape((Split-Path -Leaf $RunnerDir))
$all = Get-CimInstance Win32_Process
$roots = $all | Where-Object { $_.Name -match '^node' -and $_.CommandLine -and ($_.CommandLine -match ("run-night\.mjs|auto-story-pipeline|" + $leaf)) }
$ids = New-Object System.Collections.Generic.HashSet[int]
foreach ($r in $roots) { [void]$ids.Add([int]$r.ProcessId) }
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $changed = $true }
  }
}
$victims = $all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Sort-Object ProcessId
foreach ($v in $victims) { "kill $($v.ProcessId) $($v.Name)" }
foreach ($v in $victims) { try { Stop-Process -Id $v.ProcessId -Force -ErrorAction Stop } catch { "fail $($v.ProcessId): $($_.Exception.Message)" } }
"killed=$($victims.Count)"

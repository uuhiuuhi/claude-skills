# ops/run-hidden.ps1 — 예약작업이 부르는 숨김 기동 래퍼(콘솔 창이 떠서 키 입력으로 죽는 사고 방지).
# 사용(예약작업의 실행 명령):
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-hidden.ps1 -RunnerDir C:\path\runner -Script tools\auto\run-night.mjs -ScriptArgs "--auto-plan" -Log C:\Users\me\.claude-auto\proj\slots.log
#   powershell -NoProfile -ExecutionPolicy Bypass -File run-hidden.ps1 -RunnerDir C:\path\runner -Script tools\auto\watchdog.mjs -Log C:\Users\me\.claude-auto\proj\watchdog-run.log
# 예약작업 설정에서 「배터리 전원이면 시작 안 함 / 배터리로 바뀌면 중지」는 반드시 끈다(노트북에서 감시자가 8시간 안 돈 실사고).
param(
  [Parameter(Mandatory = $true)][string]$RunnerDir,
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(Mandatory = $true)][string]$Log,
  [string]$ScriptArgs = ''
)
$ErrorActionPreference = 'Continue'
$node = (Get-Command node -ErrorAction Stop).Source
$inner = '/c cd /d "' + $RunnerDir + '" && "' + $node + '" ' + $Script + ' ' + $ScriptArgs + ' >> "' + $Log + '" 2>&1'
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList $inner -WindowStyle Hidden -PassThru -Wait
exit $p.ExitCode

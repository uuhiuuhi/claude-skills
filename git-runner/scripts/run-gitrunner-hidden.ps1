$ErrorActionPreference = 'Continue'
# 예약 작업 BaroOS-gitrunner(1분마다) — 요청서가 없으면 bash 도 띄우지 않고 바로 끝난다
$q = Join-Path $env:USERPROFILE '.baroos-auto\gitrunner\queue'
if (-not (Get-ChildItem -Path $q -Filter *.json -ErrorAction SilentlyContinue)) { exit 0 }
$log = Join-Path $env:USERPROFILE '.baroos-auto\gitrunner\logs\gitrunner-run.log'
$bash = 'C:\Program Files\Git\bin\bash.exe'
$p = Start-Process -FilePath $bash -ArgumentList '/c/Users/user/.baroos-auto/gitrunner/gitrunner.sh' -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
exit $p.ExitCode

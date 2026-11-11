$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\user\.baroos-auto\gitrunner\run-gitrunner-hidden.ps1"'
$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3) -StartWhenAvailable
$p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName 'BaroOS-gitrunner' -Action $a -Trigger $t -Settings $s -Principal $p -Description 'gitrunner - deploy request queue, 1 per run, quiet hours 08:50-12:00 13:00-18:10 human only' -Force | Select-Object TaskName, State

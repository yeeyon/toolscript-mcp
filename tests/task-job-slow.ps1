# A fake Windows helper with a slow start (issue #149): it connects, takes 11 s to compile as a cold runner can, reports
# `ready`, waits for the frame of a task and reports a finished task. It runs no task. The host must wait for it, and
# must not fall back to the direct spawn.
param([string]$Pipe)
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::Out)
$client.Connect(5000)
$writer = New-Object System.IO.StreamWriter($client)
$writer.AutoFlush = $true
Start-Sleep -Seconds 11
$writer.Write("ready`n")
$stdin = [Console]::OpenStandardInput()
$head = New-Object byte[] 4
[void]$stdin.Read($head, 0, 4)
$writer.Write("begin`nstarted:1`nexit:7`n")
Start-Sleep -Seconds 2

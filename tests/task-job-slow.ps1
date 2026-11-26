# A fake Windows helper with a slow start (issue #149): it connects, takes 5 s to compile as a cold runner can, reports
# `ready`, waits for the frame of a task and reports a finished task. It runs no task. The host must wait for it, and
# must not fall back to the direct spawn. It runs no cmdlet, as task-job.ps1: the first cmdlet of a PowerShell can wait
# many seconds on a busy runner.
param([string]$Pipe)
$client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $Pipe, [System.IO.Pipes.PipeDirection]::Out)
$client.Connect(5000)
$writer = [System.IO.StreamWriter]::new($client)
$writer.AutoFlush = $true
[System.Threading.Thread]::Sleep(5000)
$writer.Write("ready`n")
$stdin = [Console]::OpenStandardInput()
$head = [byte[]]::new(4)
[void]$stdin.Read($head, 0, 4)
$writer.Write("begin`nstarted:1`nexit:7`n")
[System.Threading.Thread]::Sleep(2000)

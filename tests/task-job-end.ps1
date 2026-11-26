# A fake Windows helper for the lost-helper test (issue #149): it reports `ready`, waits for the frame of a task, reports
# `begin` and exits with no end report. The task never runs, and the call must give an error and no second start.
# It runs no cmdlet, as task-job.ps1: the first cmdlet of a PowerShell can wait many seconds on a busy runner.
param([string]$Pipe)
$client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $Pipe, [System.IO.Pipes.PipeDirection]::Out)
$client.Connect(5000)
$writer = [System.IO.StreamWriter]::new($client)
$writer.AutoFlush = $true
$writer.Write("ready`n")
$stdin = [Console]::OpenStandardInput()
$head = [byte[]]::new(4)
[void]$stdin.Read($head, 0, 4)
$writer.Write("begin`n")
exit 4

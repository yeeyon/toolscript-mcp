# A fake Windows helper for the lost-helper test (issue #149): it reports `ready`, waits for the frame of a task, reports
# `begin` and exits with no end report. The task never runs, and the call must give an error and no second start.
param([string]$Pipe)
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::Out)
$client.Connect(5000)
$writer = New-Object System.IO.StreamWriter($client)
$writer.AutoFlush = $true
$writer.Write("ready`n")
$stdin = [Console]::OpenStandardInput()
$head = New-Object byte[] 4
[void]$stdin.Read($head, 0, 4)
$writer.Write("begin`n")
exit 4

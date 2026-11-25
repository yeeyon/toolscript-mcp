# A fake Windows helper for the fallback test (issue #149): it reports `ready`, waits for the frame of a task, reports
# `failed:job` and exits. It never starts the task. It writes noise on its streams to show that none reaches the output.
param([string]$Pipe)
[Console]::Out.Write('helper noise')
[Console]::Error.Write('helper noise')
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::Out)
$client.Connect(5000)
$writer = New-Object System.IO.StreamWriter($client)
$writer.AutoFlush = $true
$writer.Write("ready`n")
$stdin = [Console]::OpenStandardInput()
$head = New-Object byte[] 4
[void]$stdin.Read($head, 0, 4)
$writer.Write("failed:job`n")
exit 4

# A helper that fails at the job step, for the fallback test (issue #149): it prints noise on its streams, reports
# `failed:job` on the pipe and exits. It never starts the task.
param([string]$Pipe, [string]$Data)
[Console]::Out.Write('helper noise')
[Console]::Error.Write('helper noise')
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::Out)
$client.Connect(5000)
$writer = New-Object System.IO.StreamWriter($client)
$writer.Write("failed:job`n")
$writer.Flush()
exit 4

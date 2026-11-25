# The job helper of a Workspace task on Windows (issue #149). toolscript-mcp starts it with Windows PowerShell 5.1:
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File task-job.ps1 <pipe> <data file>
# It puts itself in a Job Object that ends with its last handle, then starts the task inside the job and waits for it.
# When the helper ends, for any reason, Windows ends every process in the job, also one whose parent already exited.
#
# The task comes as data in <data file> (JSON: file, args, cwd, env), which the helper removes after it read it. No
# value of the task is part of this script or of its command line. The helper reports on the named pipe, one line each:
#   failed:<step>   it could not make the job (data, compile or job). The task did not start.
#   begin           the job is made and the task starts now
#   error:<code>    the program did not start
#   started         the program runs
# The exit code of the helper is the exit code of the task. The helper writes nothing to its output streams, which the
# task inherits.

param([string]$Pipe, [string]$Data)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $Pipe, [System.IO.Pipes.PipeDirection]::Out)
  $client.Connect(5000)
  $writer = New-Object System.IO.StreamWriter($client, (New-Object System.Text.UTF8Encoding($false)))
} catch {
  exit 3
}
function Say([string]$line) {
  $writer.Write($line + "`n")
  $writer.Flush()
}

$step = 'data'
try {
  $task = [System.IO.File]::ReadAllText($Data, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  Remove-Item -LiteralPath $Data -Force
  $step = 'compile'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TsJob {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a; public long b; public uint LimitFlags; public UIntPtr c; public UIntPtr d; public uint e; public UIntPtr f; public uint g; public uint h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p1, p2, p3, p4; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  // The handle is kept for the life of the process and is never inherited: no security attributes are given.
  public static IntPtr Job;
  public static void Enter() {
    Job = CreateJobObject(IntPtr.Zero, null);
    if (Job == IntPtr.Zero) throw new Exception("create " + Marshal.GetLastWin32Error());
    var e = new EXT();
    e.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, and no breakaway flag
    if (!SetInformationJobObject(Job, 9, ref e, (uint)Marshal.SizeOf(typeof(EXT)))) throw new Exception("set " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(Job, GetCurrentProcess())) throw new Exception("assign " + Marshal.GetLastWin32Error());
  }
}
'@
  $step = 'job'
  [TsJob]::Enter()
} catch {
  Say ('failed:' + $step)
  exit 4
}

Say 'begin'
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $task.file
  $psi.Arguments = $task.args
  $psi.WorkingDirectory = $task.cwd
  $psi.UseShellExecute = $false
  # The child gets the listed environment and nothing else: not the pipe, and not what PowerShell added.
  $psi.EnvironmentVariables.Clear()
  foreach ($property in $task.env.PSObject.Properties) { $psi.EnvironmentVariables[$property.Name] = [string]$property.Value }
  $process = [System.Diagnostics.Process]::Start($psi)
} catch {
  $problem = $_.Exception
  if ($problem.InnerException -ne $null) { $problem = $problem.InnerException }
  $code = 'error'
  if ($problem -is [System.ComponentModel.Win32Exception]) {
    switch ($problem.NativeErrorCode) {
      2 { $code = 'ENOENT' }
      3 { $code = 'ENOENT' }
      5 { $code = 'EPERM' }
      87 { $code = 'EINVAL' }
      206 { $code = 'ENAMETOOLONG' }
    }
  }
  Say ('error:' + $code)
  exit 5
}
Say 'started'
$process.WaitForExit()
exit $process.ExitCode

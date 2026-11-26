# The warm job helper of the Workspace tasks on Windows (issue #149). toolscript-mcp starts it with Windows PowerShell 5.1:
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File task-job.ps1 <report pipe name>
# One helper serves many tasks. It compiles its C# class one time, then only hosts it. For each task the class makes a new
# Job Object (KILL_ON_JOB_CLOSE, no breakaway flag), starts the task suspended, puts it in the job, then resumes it. The
# helper is not in the job and holds the only handle of it, so the job ends when the helper closes the handle or dies,
# and Windows ends every process in it, also one whose parent already exited.
#
# The values of a task never are in this file or in a command line. They come as frames on the standard input of the
# helper (4-byte length, UTF-8, fields with a NUL between them): file, command line, folder, the named pipe of stdout, the
# named pipe of stderr, then the environment as name and value pairs, used as they are. The helper reports on the named
# pipe of its argument, one line each: ready, begin, started:<pid>, error:<win32 code>, exit:<code>, failed:<step>.
# `failed` comes before `begin` only. It writes nothing to its own streams, which are closed, and nothing to the task.

param([string]$Pipe)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# The pipe is connected first, so the host sees a helper that started, and tells a slow compile from no start at all.
# Breadcrumbs go to the standard error, which the host reads (bounded) and shows when the start fails: no value of a task.
function Crumb([string]$text) { try { [Console]::Error.WriteLine("ts-helper: $text") } catch {} }
$sw = [Diagnostics.Stopwatch]::StartNew()
# No cmdlet runs in this file: the first cmdlet makes Windows PowerShell look up the command and load its module, which took
# 20 to 30 s on a runner that starts several PowerShell processes at once. Every step is a .NET call, also the compile.
# The host also sets a PSModulePath of the system folder only, so no foreign module can load.
Crumb ('script started ps=' + $PSVersionTable.PSVersion + ' clr=' + [Environment]::Version + ' up=' + [int]([DateTime]::Now - [Diagnostics.Process]::GetCurrentProcess().StartTime).TotalMilliseconds + 'ms')
try {
  $channel = [System.IO.Pipes.NamedPipeClientStream]::new('.', $Pipe, [System.IO.Pipes.PipeDirection]::Out)
  $channel.Connect(5000)
  $writer = [System.IO.StreamWriter]::new($channel, [System.Text.UTF8Encoding]::new($false))
  $writer.AutoFlush = $true
  Crumb ('connected at ' + $sw.ElapsedMilliseconds + 'ms')
} catch { Crumb ('connect failed: ' + $_.Exception.Message); exit 3 }
if ([IntPtr]::Size -ne 8) { $writer.Write("failed:bits`n"); exit 4 }
$source = @'
using System;
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TsHost {
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFO {
    public int cb; public IntPtr r1, desktop, title; public int x, y, xs, ys, xc, yc, fill, flags;
    public short show, r2; public IntPtr r3, hIn, hOut, hErr;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p1, p2, p3, p4; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, IntPtr n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder line, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    byte[] env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j, uint code);
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a, b, c, d; public uint faults, total, active, terminated; }
  [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr j, int c, out ACCOUNTING i, uint l, IntPtr r);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);

  static NamedPipeClientStream pipe;
  static System.IO.Stream input;
  static void Say(string line) { byte[] b = Encoding.UTF8.GetBytes(line + "\n"); pipe.Write(b, 0, b.Length); pipe.Flush(); }
  static byte[] Take(int count) {
    byte[] buffer = new byte[count];
    for (int have = 0; have < count;) {
      int n = input.Read(buffer, have, count - have);
      if (n <= 0) Environment.Exit(6); // the host is gone
      have += n;
    }
    return buffer;
  }
  static IntPtr Open(string name, uint access) {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
    sa.length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.inherit = 1;
    return CreateFileW(name, access, 3, ref sa, 3, 0, IntPtr.Zero);
  }

  // One thread reads the frames for the life of the helper, so a stop frame (length 0) reaches it while a task runs.
  static readonly BlockingCollection<string[]> frames = new BlockingCollection<string[]>();
  static readonly object gate = new object();
  static IntPtr live = IntPtr.Zero; // the job of the running task
  static int enqueued = 0, pendingFor = -1;
  // Ends every process of the job and waits until none is alive (at most 2 s), so a report of the end means a tree that is gone.
  // It gives the number of processes that are still alive after the wait.
  static uint Reap(IntPtr job) {
    ACCOUNTING info;
    uint size = (uint)Marshal.SizeOf(typeof(ACCOUNTING));
    bool killed = QueryInformationJobObject(job, 1, out info, size, IntPtr.Zero) && info.active > 0;
    TerminateJobObject(job, 1);
    for (int waited = 0; waited < 2000; waited += 10) {
      if (!QueryInformationJobObject(job, 1, out info, size, IntPtr.Zero) || info.active == 0) break;
      Thread.Sleep(10);
    }
    // A process that is gone can still hold its folder as its cwd for a few ms while Windows closes its handles (8 ms measured).
    if (killed) Thread.Sleep(50);
    return info.active;
  }
  static void Reader() {
    for (;;) {
      int size = BitConverter.ToInt32(Take(4), 0);
      if (size == 0) {
        lock (gate) { if (live != IntPtr.Zero) Reap(live); else pendingFor = enqueued; }
        continue;
      }
      if (size < 0 || size > 4194304) Environment.Exit(6);
      string[] fields = Encoding.UTF8.GetString(Take(size)).Split('\0');
      lock (gate) { enqueued++; }
      frames.Add(fields);
    }
  }

  public static void Serve(NamedPipeClientStream connected) {
    // No handle of the helper is inherited by a task: not the frame pipe on standard input, and not the other two.
    foreach (int which in new int[] { -10, -11, -12 }) {
      IntPtr h = GetStdHandle(which);
      if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, 1, 0);
    }
    input = Console.OpenStandardInput();
    pipe = connected;
    IntPtr bad = new IntPtr(-1);
    Thread reader = new Thread(Reader);
    reader.IsBackground = true;
    reader.Start();
    Say("ready");
    for (int number = 1; ; number++) {
      string[] parts = frames.Take();
      if (parts.Length < 5) { Say("failed:frame"); Environment.Exit(4); }
      IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
      EXT limits = new EXT();
      limits.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE, and no breakaway flag
      if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXT)))) { Say("failed:job"); Environment.Exit(4); }
      IntPtr nul = Open("NUL", 0x80000000), output = Open("\\\\.\\pipe\\" + parts[3], 0x40000000), error = Open("\\\\.\\pipe\\" + parts[4], 0x40000000);
      if (nul == bad || output == bad || error == bad) { Say("failed:streams"); Environment.Exit(4); }
      StringBuilder block = new StringBuilder();
      for (int i = 5; i + 1 < parts.Length; i += 2) block.Append(parts[i]).Append('=').Append(parts[i + 1]).Append('\0');
      block.Append('\0');
      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
      si.flags = 0x100; // STARTF_USESTDHANDLES
      si.hIn = nul; si.hOut = output; si.hErr = error;
      PROCESS_INFORMATION pi;
      // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW: the task runs no code before it is in the job.
      bool made = CreateProcessW(parts[0], new StringBuilder("\"" + parts[0] + "\" " + parts[1]), IntPtr.Zero, IntPtr.Zero, true, 0x08000404,
        Encoding.Unicode.GetBytes(block.ToString()), parts[2], ref si, out pi);
      int problem = Marshal.GetLastWin32Error();
      CloseHandle(nul); CloseHandle(output); CloseHandle(error);
      if (!made) { CloseHandle(job); Say("error:" + problem); continue; }
      if (!AssignProcessToJobObject(job, pi.hProcess)) { TerminateProcess(pi.hProcess, 1); Say("failed:assign"); Environment.Exit(4); }
      // A stop frame that came before the task was in the job ends it now; it ran no code yet.
      lock (gate) { live = job; if (pendingFor == number) Reap(job); }
      Say("begin");
      ResumeThread(pi.hThread);
      CloseHandle(pi.hThread);
      Say("started:" + pi.pid);
      WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code;
      GetExitCodeProcess(pi.hProcess, out code);
      CloseHandle(pi.hProcess);
      // Ends what the task left behind and waits until it is gone, so no process holds the streams or the folder of the task.
      uint left;
      lock (gate) { left = Reap(job); live = IntPtr.Zero; CloseHandle(job); }
      if (left > 0) Say("left:" + left); // before exit: the exit report ends the channel
      Say("exit:" + code);
    }
  }
}
'@
# The same csc compile that the Add-Type cmdlet runs, called as .NET: no cmdlet, so no command lookup.
try {
  $options = [System.CodeDom.Compiler.CompilerParameters]::new()
  $options.GenerateInMemory = $true
  [void]$options.ReferencedAssemblies.Add('System.dll')
  [void]$options.ReferencedAssemblies.Add('System.Core.dll')
  $results = [Microsoft.CSharp.CSharpCodeProvider]::new().CompileAssemblyFromSource($options, $source)
  if ($results.Errors.HasErrors) { throw $results.Errors[0].ErrorText }
} catch { Crumb ('compile failed: ' + $_.Exception.Message); $writer.Write("failed:compile`n"); exit 4 }
Crumb ('compiled at ' + $sw.ElapsedMilliseconds + 'ms')
try { [TsHost]::Serve($channel) } catch { Crumb ('serve failed: ' + $_.Exception.Message); exit 5 }

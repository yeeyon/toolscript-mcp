// The child guard of Windows (opt-in with TOOLSCRIPT_CHILD_GUARD=1). toolscript-mcp compiles this file one time with the
// csc.exe of .NET Framework, keeps the program under ~/.toolscript-mcp/guard (named by a hash of this text) and starts it
// once for each host or broker: child-guard.exe <pid of the host>
//
// It makes one Job Object (KILL_ON_JOB_CLOSE, breakaway allowed), and for each line `guard <pid>` on its standard input it
// puts that process in the job, then every descendant of the processes that it holds (a `cmd /c` wrapper can start its
// server before the assign), by parent pid, until a pass finds none. A process that a member starts is a member. When the
// host is gone (its process handle is signalled, or the standard input ends) this program exits, the last handle of the
// job closes, and the kernel ends every process in it. It is not in its own job. It reads and writes only pids and the
// words ready and guarded: no command, argument or environment value ever reaches it.

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class ChildGuard {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p1, p2, p3, p4; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PE { public uint size, usage, pid; public IntPtr heap; public uint modid, threads, ppid; public int pri; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, IntPtr n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, uint l);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE e);

  static IntPtr job;
  static readonly HashSet<int> assigned = new HashSet<int>();

  static bool Assign(int pid) {
    // PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    IntPtr h = OpenProcess(0x1 | 0x100 | 0x1000 | 0x100000, false, pid);
    if (h == IntPtr.Zero) return false;
    bool ok = AssignProcessToJobObject(job, h);
    CloseHandle(h);
    if (ok) assigned.Add(pid);
    return ok;
  }

  // The descendants of the processes that the job holds, by parent pid, until a pass finds none. It gives their number.
  static int Sweep() {
    int found = 0;
    for (int pass = 0; pass < 8; pass++) {
      int before = found;
      IntPtr snap = CreateToolhelp32Snapshot(2, 0);
      PE e = new PE();
      e.size = (uint)Marshal.SizeOf(typeof(PE));
      List<int[]> rows = new List<int[]>();
      if (Process32FirstW(snap, ref e)) { do { rows.Add(new int[] { (int)e.pid, (int)e.ppid }); } while (Process32NextW(snap, ref e)); }
      CloseHandle(snap);
      foreach (int[] r in rows) if (assigned.Contains(r[1]) && !assigned.Contains(r[0]) && Assign(r[0])) found++;
      if (found == before) break;
    }
    return found;
  }

  public static int Main(string[] args) {
    int hostPid;
    if (args.Length != 1 || !int.TryParse(args[0], out hostPid)) return 2;
    job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    EXT limits = new EXT();
    limits.Basic.LimitFlags = 0x2000 | 0x800; // KILL_ON_JOB_CLOSE, breakaway allowed
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXT)))) return 3;
    IntPtr host = OpenProcess(0x100000, false, hostPid);
    if (host == IntPtr.Zero) return 4;
    Thread watch = new Thread(() => { WaitForSingleObject(host, 0xFFFFFFFF); Environment.Exit(0); });
    watch.IsBackground = true;
    watch.Start();
    TextWriter output = Console.Out;
    output.WriteLine("ready");
    output.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      int pid;
      if (!line.StartsWith("guard ") || !int.TryParse(line.Substring(6), out pid) || pid <= 0) continue;
      bool ok = Assign(pid);
      int more = Sweep();
      output.WriteLine("guarded:" + pid + ":" + ok + ":" + more);
      output.Flush();
    }
    return 0; // the host closed our standard input: the job closes with this process
  }
}

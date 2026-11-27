// The child guard of Windows (opt-in with TOOLSCRIPT_CHILD_GUARD=1). toolscript-mcp compiles this file one time with the
// csc.exe of .NET Framework, keeps the program under ~/.toolscript-mcp/guard (named by a hash of this text) and starts it
// once for each host or broker: child-guard.exe <pid of the host>
//
// It makes one Job Object (KILL_ON_JOB_CLOSE, breakaway allowed). For each line `guard <pid>` on its standard input it
// puts that process in the job, but only a process that the host started: its parent is the host and it is not older than
// the host. Then it puts in the job every descendant of the processes that it holds (a `cmd /c` wrapper can start its
// server before the assign), by parent pid, until a pass finds none. Windows never updates the parent pid of a process
// and reuses pids within seconds, so a descendant counts only when it is not older than its parent, and a member whose
// process has exited is dropped at once, with its handle. A process that a member starts is a member. When the host is
// gone (its process handle is signalled, or the standard input ends) this program exits, the last handle of the job
// closes, and the kernel ends every process in it. It is not in its own job. It reads and writes only pids and the
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
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE e);

  // PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
  const uint ACCESS = 0x1 | 0x100 | 0x1000 | 0x100000;

  class Member { public IntPtr Handle; public long Created; }

  static IntPtr job;
  static int hostPid;
  static long hostCreated;
  static readonly Dictionary<int, Member> members = new Dictionary<int, Member>();

  // The processes of the system now: pid and parent pid.
  static List<int[]> Snapshot() {
    List<int[]> rows = new List<int[]>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    PE e = new PE();
    e.size = (uint)Marshal.SizeOf(typeof(PE));
    if (Process32FirstW(snap, ref e)) { do { rows.Add(new int[] { (int)e.pid, (int)e.ppid }); } while (Process32NextW(snap, ref e)); }
    CloseHandle(snap);
    return rows;
  }

  // Puts the process in the job, if it is not older than `notBefore` (the creation time of its parent). It keeps the handle.
  static bool Adopt(int pid, long notBefore) {
    IntPtr h = OpenProcess(ACCESS, false, pid);
    if (h == IntPtr.Zero) return false;
    long created, exited, kernel, user;
    if (!GetProcessTimes(h, out created, out exited, out kernel, out user) || created < notBefore || WaitForSingleObject(h, 0) == 0 || !AssignProcessToJobObject(job, h)) {
      CloseHandle(h);
      return false;
    }
    Member m = new Member();
    m.Handle = h;
    m.Created = created;
    members[pid] = m;
    return true;
  }

  // A member whose process has exited is dropped, so its pid can never match a later process that reuses it.
  static void Prune() {
    List<int> gone = new List<int>();
    foreach (KeyValuePair<int, Member> pair in members) if (WaitForSingleObject(pair.Value.Handle, 0) == 0) gone.Add(pair.Key);
    foreach (int pid in gone) { CloseHandle(members[pid].Handle); members.Remove(pid); }
  }

  // The descendants of the members, by parent pid, each not older than its parent, until a pass finds none.
  static int Sweep() {
    int found = 0;
    for (int pass = 0; pass < 8; pass++) {
      Prune();
      int before = found;
      foreach (int[] r in Snapshot()) {
        Member parent;
        if (members.ContainsKey(r[0]) || !members.TryGetValue(r[1], out parent)) continue;
        if (Adopt(r[0], parent.Created)) found++;
      }
      if (found == before) break;
    }
    return found;
  }

  // `guard <pid>`: only a process that the host started, which is its child by parent pid and not older than the host.
  static bool Guard(int pid) {
    foreach (int[] r in Snapshot()) if (r[0] == pid) return r[1] == hostPid && Adopt(pid, hostCreated);
    return false;
  }

  public static int Main(string[] args) {
    if (args.Length != 1 || !int.TryParse(args[0], out hostPid)) return 2;
    job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    EXT limits = new EXT();
    limits.Basic.LimitFlags = 0x2000 | 0x800; // KILL_ON_JOB_CLOSE, breakaway allowed
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXT)))) return 3;
    IntPtr host = OpenProcess(0x100000 | 0x1000, false, hostPid);
    long exited, kernel, user;
    if (host == IntPtr.Zero || !GetProcessTimes(host, out hostCreated, out exited, out kernel, out user)) return 4;
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
      Prune();
      bool ok = members.ContainsKey(pid) || Guard(pid);
      int more = Sweep();
      output.WriteLine("guarded:" + pid + ":" + ok + ":" + more);
      output.Flush();
    }
    return 0; // the host closed our standard input: the job closes with this process
  }
}

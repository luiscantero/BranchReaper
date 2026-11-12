import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Logger } from "./git";

export interface Locker {
  pid: number;
  name: string;
  reason: string;
}

/**
 * Restart Manager reports processes with files open in the folder. Processes whose working
 * directory is in the folder (shells, agents) also block deleting it on Windows, but Restart
 * Manager does not see directory handles, so their working directory is read from their PEB.
 */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$dir = [System.IO.Path]::GetFullPath($env:BRANCH_REAPER_LOCK_PATH).TrimEnd('\')
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class BranchReaperLocks {
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, StringBuilder strSessionKey);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint pSessionHandle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames, uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo, [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

  public static List<string> FileLockers(string[] files) {
    var result = new List<string>();
    uint session;
    if (RmStartSession(out session, 0, new StringBuilder(64)) != 0) return result;
    try {
      if (RmRegisterResources(session, (uint)files.Length, files, 0, null, 0, null) != 0) return result;
      uint needed = 0, count = 0, reasons = 0;
      int rc = RmGetList(session, out needed, ref count, null, ref reasons);
      if (rc == 234 && needed > 0) {
        var infos = new RM_PROCESS_INFO[needed];
        count = needed;
        rc = RmGetList(session, out needed, ref count, infos, ref reasons);
        if (rc == 0) {
          for (int i = 0; i < count; i++) result.Add(infos[i].Process.dwProcessId + "\t" + infos[i].strAppName);
        }
      }
    } finally {
      RmEndSession(session);
    }
    return result;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_BASIC_INFORMATION {
    public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask;
    public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId;
  }

  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returnLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")]
  static extern bool IsWow64Process(IntPtr process, out bool wow64);

  // Current directory of a 64-bit process: PEB.ProcessParameters (+0x20) -> CurrentDirectory.DosPath (+0x38).
  public static string GetCwd(int pid) {
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      bool wow64;
      if (IsWow64Process(h, out wow64) && wow64) return null;
      var info = new PROCESS_BASIC_INFORMATION();
      int returned;
      if (NtQueryInformationProcess(h, 0, ref info, Marshal.SizeOf(info), out returned) != 0) return null;
      var pointer = new byte[8];
      IntPtr read;
      if (!ReadProcessMemory(h, info.PebBaseAddress + 0x20, pointer, (IntPtr)8, out read)) return null;
      var parameters = (IntPtr)BitConverter.ToInt64(pointer, 0);
      var unicodeString = new byte[16];
      if (!ReadProcessMemory(h, parameters + 0x38, unicodeString, (IntPtr)16, out read)) return null;
      int length = BitConverter.ToUInt16(unicodeString, 0);
      var buffer = (IntPtr)BitConverter.ToInt64(unicodeString, 8);
      if (length == 0 || buffer == IntPtr.Zero) return null;
      var text = new byte[length];
      if (!ReadProcessMemory(h, buffer, text, (IntPtr)length, out read)) return null;
      return Encoding.Unicode.GetString(text);
    } finally {
      CloseHandle(h);
    }
  }
}
'@
$found = @{}
function Add-Locker([int]$id, [string]$name, [string]$reason) {
  $key = [string]$id + '|' + $reason
  if (-not $found.ContainsKey($key)) { $found[$key] = [pscustomobject]@{ pid = $id; name = $name; reason = $reason } }
}
$files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force | Select-Object -First 3000 | ForEach-Object { $_.FullName })
if ($files.Count -gt 0) {
  foreach ($line in [BranchReaperLocks]::FileLockers([string[]]$files)) {
    $parts = $line.Split([char]9)
    $proc = Get-Process -Id ([int]$parts[0])
    $name = if ($proc) { $proc.ProcessName } else { $parts[1] }
    Add-Locker ([int]$parts[0]) $name 'has files open in it'
  }
}
$prefix = $dir + '\'
foreach ($p in Get-Process) {
  if ($p.Id -eq $PID) { continue }
  $cwd = [BranchReaperLocks]::GetCwd($p.Id)
  if ($cwd) {
    $c = $cwd.TrimEnd('\')
    if ($c -ieq $dir -or $c.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      Add-Locker $p.Id $p.ProcessName ('its working directory is ' + $c)
    }
  }
  $exe = $p.Path
  if ($exe -and $exe.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    Add-Locker $p.Id $p.ProcessName 'it runs from the folder'
  }
}
ConvertTo-Json -Compress -InputObject @($found.Values)
`;

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd: os.tmpdir(), env, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error ? error.message : "") });
    });
  });
}

function findOnPath(names: readonly string[]): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (dir && fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function windowsLockers(dir: string, log: Logger): Promise<Locker[]> {
  const lockers: Locker[] = [];
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
  const result = await run(
    fs.existsSync(powershell) ? powershell : "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { ...process.env, BRANCH_REAPER_LOCK_PATH: dir },
    30_000,
  );
  if (result.code === 0 && result.stdout.trim()) {
    try {
      const parsed = JSON.parse(result.stdout.trim()) as Locker | Locker[];
      lockers.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      log.warn(`Could not parse the locking process list: ${result.stdout.trim()}`);
    }
  } else {
    log.warn(`Looking up locking processes failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  const handle = findOnPath(["handle64.exe", "handle.exe"]);
  if (handle) {
    const out = await run(handle, ["-accepteula", "-nobanner", dir], process.env, 30_000);
    for (const line of out.stdout.split(/\r?\n/)) {
      const match = /^(.+?)\s+pid:\s*(\d+)\s+type:\s*(\S+)\s+[0-9A-F]+:\s*(.*)$/i.exec(line.trim());
      if (match) {
        lockers.push({ pid: Number(match[2]), name: match[1].replace(/\.exe$/i, ""), reason: `has ${match[4].trim()} open (handle.exe)` });
      }
    }
  }
  return lockers;
}

async function lsofLockers(dir: string): Promise<Locker[]> {
  const out = await run("lsof", ["-F", "pc", "+D", dir], process.env, 10_000);
  const lockers: Locker[] = [];
  let pid: number | undefined;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("c") && pid !== undefined) {
      lockers.push({ pid, name: line.slice(1), reason: "has files open in it" });
    }
  }
  return lockers;
}

/** Best-effort list of processes that keep `dir` in use, de-duplicated by process. */
export async function findLockers(dir: string, log: Logger): Promise<Locker[]> {
  try {
    const all = process.platform === "win32" ? await windowsLockers(dir, log) : await lsofLockers(dir);
    const byPid = new Map<number, Locker>();
    for (const locker of all) {
      if (locker.pid === process.pid) {
        locker.name = `${locker.name} (this VS Code window)`;
      }
      const existing = byPid.get(locker.pid);
      if (!existing) {
        byPid.set(locker.pid, { ...locker });
      } else if (!existing.reason.includes(locker.reason)) {
        existing.reason = `${existing.reason}; ${locker.reason}`;
      }
    }
    return [...byPid.values()];
  } catch (e) {
    log.warn(`Looking up locking processes failed: ${(e as Error).message}`);
    return [];
  }
}

export function describeLockers(lockers: readonly Locker[]): string {
  return lockers.map((l) => `${l.name} (PID ${l.pid})`).join(", ");
}

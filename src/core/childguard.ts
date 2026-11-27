// The child guard (decision: a stdio child never outlives a host that was killed): the pure parts. A host that dies with
// no cleanup (SIGKILL, TerminateProcess, a crash) ends no tree, so a server that ignores stdin EOF, or the server behind
// `cmd /c` or `sh -c`, lives on. Outside Windows a `/bin/sh` watchdog reads lines from a pipe that only the host holds
// and, at EOF, kills the process groups still listed. On Windows, when the person turns it on, a small compiled
// program puts each child in a Job Object that the kernel closes when the program ends. Only pids ever go to either.
// `src/host/childguard.ts` runs them.

/** The switch. Outside Windows the guard is on unless the value is `0`. On Windows it is on only when the value is `1`. */
export const GUARD_ENV = 'TOOLSCRIPT_CHILD_GUARD'

/** The Defender attack surface reduction rule that can stop a program that was just compiled from starting. */
export const ASR_RULE = '01443614-CD74-433A-B99E-2ECDC07BFC25'

export const guardWanted = (platform: string, value: string | undefined): boolean =>
  platform === 'win32' ? value === '1' : value !== '0'

/**
 * The text of the watchdog, for `/bin/sh -c`. It reads `+<pgid>` and `-<pgid>` lines and, when its input ends, sends
 * SIGKILL to each group that is still listed. `kill -s KILL -- -$p` is the form that dash accepts (`kill -KILL --` is
 * not). It holds no value of an entry: only group ids.
 */
export const WATCHDOG =
  'list=""; while IFS= read -r l; do case $l in +*) list="$list ${l#+}";; -*) p=${l#-}; new=""; ' +
  'for x in $list; do [ "$x" = "$p" ] || new="$new $x"; done; list=$new;; esac; done; ' +
  'for p in $list; do kill -s KILL -- -$p 2>/dev/null; done'

const isPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0

/** The line that lists the group of a child (the child is the leader of its group). Undefined for a bad pid. */
export const plusLine = (pid: number): string | undefined => (isPid(pid) ? `+${pid}\n` : undefined)
/** The line that removes the group of a child that ended, before its group id can be reused. */
export const minusLine = (pid: number): string | undefined => (isPid(pid) ? `-${pid}\n` : undefined)
/** The line that asks the Windows program to put a child in its job. */
export const guardLine = (pid: number): string | undefined => (isPid(pid) ? `guard ${pid}\n` : undefined)

/** The file name of the compiled Windows program: a hash of its source, so a changed source never runs the old file. */
export const guardExeName = (sourceHash: string): string => `child-guard-${sourceHash.slice(0, 16)}.exe`

/** The line of the log (the caller adds the `toolscript-mcp:` prefix), and the text of `doctor`, when the guard is off. */
export const offLine = (why: string): string =>
  `child guard: off, ${why}. A host that is killed leaves its servers running`

/** The reason of a Windows guard that could not start, naming the rule that can cause it. */
export const windowsFailure = (why: string): string =>
  `${why}. A Defender rule such as ${ASR_RULE} (block executable files unless they meet a prevalence, age or trusted list criterion) can stop the program from starting. ${GUARD_ENV}=1 turns it on; unset it to turn it off`

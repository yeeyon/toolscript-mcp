// The shells in which a test runs the command lines that the CLI prints, as a person or an agent pastes them. Each
// `run` gets the lines in order and returns what the shell printed. cmd.exe runs each line alone, as `cmd /d /s /c`.

import { spawnSync } from 'node:child_process'

export type Shell = {
  readonly present: () => boolean
  readonly run: (lines: readonly string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => string
}

const hidden = { encoding: 'utf8', windowsHide: true } as const
const out = (run: ReturnType<typeof spawnSync<string>>) => `${run.stdout}${run.stderr}`
const gitBash = () =>
  process.platform === 'win32' && spawnSync('bash', ['-c', 'uname -o'], hidden).stdout?.trim() === 'Msys'
const runs = (exe: string) => spawnSync(exe, ['-c', 'exit 0'], hidden).error === undefined
const powershell = (exe: string): Shell => ({
  present: () => spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], hidden).error === undefined,
  run: (lines, opts) =>
    out(spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', lines.join('\n')], { ...hidden, ...opts })),
})

export const SHELLS: Readonly<Record<string, Shell>> = {
  sh: {
    present: () => process.platform !== 'win32' && runs('sh'),
    run: (lines, opts) => out(spawnSync('sh', ['-c', lines.join('\n')], { ...hidden, ...opts })),
  },
  'git bash': {
    present: gitBash,
    run: (lines, opts) => out(spawnSync('bash', ['-c', lines.join('\n')], { ...hidden, ...opts })),
  },
  // An interactive bash expands ! history in double quotes.
  'bash -i': {
    present: () => (process.platform === 'win32' ? gitBash() : runs('bash')),
    run: (lines, opts) =>
      out(
        spawnSync('bash', ['--norc', '--noprofile', '-i'], {
          ...hidden,
          ...opts,
          input: `${[...lines, 'exit'].join('\n')}\n`,
        }),
      ),
  },
  pwsh: powershell('pwsh'),
  'Windows PowerShell': { ...powershell('powershell.exe'), present: () => process.platform === 'win32' },
  'cmd.exe': {
    present: () => process.platform === 'win32',
    run: (lines, { cwd, env }) =>
      lines
        .map(line =>
          out(
            spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
              ...hidden,
              cwd,
              env,
              windowsVerbatimArguments: true,
            }),
          ),
        )
        .join('\n'),
  },
}

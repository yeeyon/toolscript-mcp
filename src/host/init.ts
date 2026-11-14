// `toolscript-mcp init`: reads the MCP servers of the clients, writes the
// toolscript-mcp config with mode 0600 and prints what to change in each
// client. It never writes a client file. It prints to stderr, as the server
// does: the text is for a person, and the config file is the output.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { configPath, SECRET_NAMES, SECRET_WORD_LENGTH, type Env } from '../core/config.ts'
import {
  clientFiles,
  configText,
  importServers,
  initReport,
  oldConfigReport,
  type ClientFile,
  type ClientRead,
} from '../core/init.ts'
import { errorText } from '../core/protocol.ts'

export const INIT_USAGE = 'usage: toolscript-mcp init [--config <path>] [--force] [--dry-run]'

const LONG_WORD = `${SECRET_WORD_LENGTH} or more letters, digits, _ and -, with letters and digits`
const NAMES = `${SECRET_NAMES.slice(0, -1).join(', ')} or ${SECRET_NAMES.at(-1)}`

/** What the dry run shows as `***`: the rules of hideArgSecrets. */
const HIDDEN = [
  'These show as ***:',
  '- the values of env and headers',
  `- in a URL: the user and password, each query value, the fragment, and each path segment of ${LONG_WORD}`,
  `- the value of an argument whose name holds ${NAMES}: --name value, --name=value, NAME=value, Name: value`,
  '- the word after Bearer or Basic',
  `- an argument of ${LONG_WORD}`,
  'Other arguments show as they are. If one of them holds a secret, do not share this output.',
]

const readClient = async (file: ClientFile): Promise<ClientRead> => {
  const at = { client: file.client, path: path.resolve(file.path) }
  try {
    return { ...at, kind: 'text', text: await fs.promises.readFile(at.path, 'utf8') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...at, kind: 'missing' }
    return { ...at, kind: 'unreadable', error: errorText(err) }
  }
}

/** The bytes of `file`, or undefined when there is no such file. */
const readIfAny = (file: string): Promise<Buffer | undefined> =>
  fs.promises.readFile(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined
    throw err
  })

/**
 * Writes a config, which holds the env and header values of the servers, so that only the user reads it: a new
 * 0600 file in the same folder, then a rename onto `file`. The secrets never go into an old file that others can
 * read, and `file` never holds a part of a config. Without `replace`, the link fails with EEXIST when `file` exists.
 */
const writeConfig = async (file: string, text: string | Uint8Array, replace: boolean): Promise<void> => {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temp, text, { mode: 0o600, flag: 'wx' })
    await (replace ? fs.promises.rename(temp, file) : fs.promises.link(temp, file))
  } finally {
    await fs.promises.rm(temp, { force: true })
  }
}

/** Runs init with these arguments and returns the exit code. `home` and `env` name every file it reads. */
export const runInit = async (
  args: readonly string[],
  env: Env,
  platform: string,
  home: string,
  print: (text: string) => void,
): Promise<number> => {
  let options: { config?: string; force?: boolean; 'dry-run'?: boolean }
  try {
    options = parseArgs({
      args: [...args],
      options: { config: { type: 'string' }, force: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    }).values
  } catch (err) {
    print(`${errorText(err)}\n${INIT_USAGE}`)
    return 2
  }
  const file = path.resolve(configPath(options.config, env, platform, home))
  const imported = importServers(await Promise.all(clientFiles(env, platform, home).map(readClient)))
  const report = initReport(imported, file, platform)
  if (imported.servers.size === 0) {
    print(report)
    return 1
  }

  const bak = `${file}.bak`
  let old: Buffer | undefined
  try {
    old = options.force ? await readIfAny(file) : undefined
  } catch (err) {
    print(`cannot read ${file}: ${errorText(err)}`)
    return 1
  }
  const oldReport = old === undefined ? [] : oldConfigReport(old.toString('utf8'), imported.servers, bak)

  if (options['dry-run']) {
    const existing =
      old !== undefined
        ? [`${file} exists. init would replace it and keep the old file as ${bak}.`, ...oldReport]
        : !options.force && fs.existsSync(file)
          ? [`${file} exists, so init refuses to replace it without --force.`]
          : []
    print(
      [
        `Dry run: init writes nothing. It would write this config to ${file}.`,
        ...existing,
        ...HIDDEN,
        '',
        configText(imported.servers, true),
        report,
      ].join('\n'),
    )
    return 0
  }

  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    if (old !== undefined) await writeConfig(bak, old, true)
    await writeConfig(file, configText(imported.servers, false), options.force === true)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      print(`${file} exists. init did not change it. To replace it, run init again with --force.`)
      return 1
    }
    print(`cannot write ${file}: ${errorText(err)}`)
    return 1
  }
  const kept = old === undefined ? [] : [`${bak} holds the old config (mode 0600).`, ...oldReport]
  print([`Wrote ${file}.`, ...kept, '', report].join('\n'))
  return 0
}

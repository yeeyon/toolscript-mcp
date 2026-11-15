// `toolscript-mcp init`: reads the MCP servers of the clients, writes the
// toolscript-mcp config with mode 0600 and prints what to change in each
// client. It never writes a client file. It prints to stderr, as the server
// does: the text is for a person, and the config file is the output.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { configPath, SECRET_NAMES, SECRET_PARTS, SECRET_WORD_LENGTH, type Env } from '../core/config.ts'
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

const list = (words: readonly string[]) => `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`

/** What the dry run shows as `***`: the rules of hideUrlSecrets and hideArgSecrets. */
const HIDDEN = [
  'These show as ***:',
  '- the values of env and headers',
  '- in a URL: the user and password, each query value or part, each ;name=value path value, the fragment, and each path segment that is a long word',
  `- the value of a name that holds ${list(SECRET_NAMES)}, or the part ${list(SECRET_PARTS)}: --name value, --name=value, --name= value, NAME=value, Name: value, Server=db;Password=value`,
  '- in a JSON argument: each value under a key with such a name, also nested, except a label such as name or user, and the secrets in the other strings',
  '- the value after -t or -p, unless it is a number, a port such as 8080:80, a path or an @scope package',
  '- the password of user:password after -u, --user or --proxy-user, unless a side is a number or both sides are the same, as in a docker user and group',
  '- after -H, the value of a header with such a name, and the secrets in other header values',
  '- the word after Bearer or Basic',
  `- a long word: ${SECRET_WORD_LENGTH} or more letters, digits, _ and - with letters and digits, or with upper and lower case also . / + = : ~ %, when it does not start as a path`,
  'An argument of several words, such as a sh -c script, gets these rules word by word.',
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
 * A file system without hard links (vfat, exFAT, some SMB and FUSE mounts) gets an exclusive copy, which also fails
 * with EEXIST.
 */
const writeConfig = async (file: string, text: string | Uint8Array, replace: boolean): Promise<void> => {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.promises.writeFile(temp, text, { mode: 0o600, flag: 'wx' })
    if (replace) await fs.promises.rename(temp, file)
    else await fs.promises.link(temp, file).catch(() => fs.promises.copyFile(temp, file, fs.constants.COPYFILE_EXCL))
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
  // Windows does not apply the mode.
  const mode = platform === 'win32' ? '' : ' (mode 0600)'
  const kept = old === undefined ? [] : [`${bak} holds the old config${mode}.`, ...oldReport]
  print([`Wrote ${file}.`, ...kept, '', report].join('\n'))
  return 0
}

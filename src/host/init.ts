// `toolscript-mcp init`: reads the MCP servers of the clients, writes the
// toolscript-mcp config with mode 0600 and prints what to change in each
// client. It never writes a client file. It prints to stderr, as the server
// does: the text is for a person, and the config file is the output.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { configPath, SECRET_NAMES, SECRET_PARTS, SECRET_WORD_LENGTH, type Env, type Launch } from '../core/config.ts'
import {
  addedConfigText,
  addReport,
  clientFiles,
  configText,
  fileServers,
  importServers,
  initReport,
  listReport,
  mainCheckoutOf,
  NO_CONFIG,
  oldConfigReport,
  parseOldConfig,
  planAdd,
  scopedFiles,
  sourceName,
  type ClientFile,
  type ClientRead,
  type ProjectFolders,
} from '../core/init.ts'
import { errorText } from '../core/protocol.ts'

export const INIT_USAGE = [
  'usage: toolscript-mcp init [--config <path>] [--force] [--dry-run] [--help]',
  '       toolscript-mcp init --list [--project <dir>] [--config <path>]',
  '       toolscript-mcp init --add <name>[,<name>...] [--from <client>[:<scope>]] [--project <dir>] [--config <path>]',
].join('\n')

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
  const at = { ...file, path: path.resolve(file.path) }
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

type Options = {
  config?: string
  force?: boolean
  'dry-run'?: boolean
  list?: boolean
  add?: string[]
  from?: string
  project?: string
  help?: boolean
}

const misuseOf = (o: Options): string | undefined => {
  const pick = o.list === true || o.add !== undefined
  if (o.list && o.add) return '--list and --add do not go together.'
  if (pick && (o.force || o['dry-run'])) return '--force and --dry-run do not go with --list or --add.'
  if (o.from !== undefined && !o.add) return '--from goes only with --add.'
  if (o.project !== undefined && !pick) return '--project goes only with --list or --add.'
  return undefined
}

/** The folders of Claude Code for a session started in `start`: the nearest folder up with `.git` decides. */
const projectFolders = async (start: string): Promise<ProjectFolders> => {
  for (let dir = start; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git')
    const stat = await fs.promises.stat(dotGit).catch(() => undefined)
    if (stat?.isDirectory()) return { local: dir, shared: dir }
    if (stat?.isFile()) {
      const main = mainCheckoutOf(await fs.promises.readFile(dotGit, 'utf8').catch(() => ''))
      return { local: main === undefined ? dir : path.resolve(dir, main), shared: dir }
    }
    if (path.dirname(dir) === dir) return { local: start, shared: start }
  }
}

/** `--list` and `--add`: the servers of every client file and Claude Code scope against the config in `file`. */
const pick = async (
  options: Options,
  file: string,
  env: Env,
  platform: string,
  home: string,
  print: (text: string) => void,
  launch: Launch,
): Promise<number> => {
  const project = await projectFolders(path.resolve(options.project ?? process.cwd()))
  const reads = await Promise.all(scopedFiles(env, platform, home, project).map(readClient))
  const files = reads.map(read => fileServers(read, platform))
  const sources = [...new Set(files.flatMap(f => [f.file.client, sourceName(f.file)]))]
  if (options.from !== undefined && !sources.includes(options.from)) {
    print(`--from takes one of ${list(sources)}.\n${INIT_USAGE}`)
    return 2
  }
  let old: Buffer | undefined
  try {
    old = await readIfAny(file)
  } catch (err) {
    print(`cannot read ${file}: ${errorText(err)}`)
    return 1
  }
  const parsed = old === undefined ? undefined : parseOldConfig(old.toString('utf8'))
  if (parsed !== undefined && !parsed.ok) {
    print(`${file} is not a valid config: ${parsed.why}. init did not change it.`)
    return 1
  }
  const config = parsed?.config
  if (options.list) {
    print(listReport(files, config ?? NO_CONFIG))
    return 0
  }
  const names = (options.add ?? []).flatMap(a => a.split(',')).map(n => n.trim())
  if (names.some(n => n === '')) {
    print(`--add takes server names, separated by commas.\n${INIT_USAGE}`)
    return 2
  }
  const plan = planAdd(files, names, options.from, config ?? NO_CONFIG)
  if (!plan.ok) {
    print([...plan.errors, `init did not change ${file}.`].join('\n'))
    return 1
  }
  const bak = `${file}.bak`
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    if (old !== undefined) await writeConfig(bak, old, true)
    await writeConfig(file, addedConfigText(config, plan.added), old !== undefined)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      print(`${file} appeared while init ran. init did not change it. Run init --add again.`)
      return 1
    }
    print(`cannot write ${file}: ${errorText(err)}`)
    return 1
  }
  const mode = platform === 'win32' ? '' : ' (mode 0600)'
  const kept = old === undefined ? [] : [`${bak} holds the old config${mode}.`]
  print([`Wrote ${file}.`, ...kept, '', ...addReport(plan.added, file, platform, launch)].join('\n'))
  return 0
}

/** Runs init with these arguments and returns the exit code. `home` and `env` name every file it reads. */
export const runInit = async (
  args: readonly string[],
  env: Env,
  platform: string,
  home: string,
  print: (text: string) => void,
  launch: Launch,
): Promise<number> => {
  let options: Options
  try {
    options = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string' },
        force: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        list: { type: 'boolean' },
        add: { type: 'string', multiple: true },
        from: { type: 'string' },
        project: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch (err) {
    print(`${errorText(err)}\n${INIT_USAGE}`)
    return 2
  }
  if (options.help) {
    print(INIT_USAGE)
    return 0
  }
  const misuse = misuseOf(options)
  if (misuse !== undefined) {
    print(`${misuse}\n${INIT_USAGE}`)
    return 2
  }
  const file = path.resolve(configPath(options.config, env, platform, home))
  if (options.list || options.add) return pick(options, file, env, platform, home, print, launch)
  const imported = importServers(await Promise.all(clientFiles(env, platform, home).map(readClient)), platform)
  const report = initReport(imported, file, platform, launch)
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

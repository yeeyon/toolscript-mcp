// Shows and changes the toolscript-mcp config file without printing a secret.
// It never prints args, env, headers, OAuth values or a URL path, query or login.
// Usage:
//   node config.mjs path
//   node config.mjs <config>
//   node config.mjs <config> policy [<action> <match>]...
//   node config.mjs <config> prepend <action> <match> [<action> <match>]...
//   node config.mjs <config> add <name> <entry.json>
//   node config.mjs <config> untrusted <name> [true|false]
//   node config.mjs <config> share <name> [true|false]
//   node config.mjs <config> workspace
//   node config.mjs <config> workspace add <folder>
//   node config.mjs <config> workspace remove <folder>
//   node config.mjs <config> workspace write <folder> [true|false]
//   node config.mjs <config> workspace task <folder> <name> <task.json>
// path prints the default config path, as toolscript-mcp finds it without --config.
// policy writes the rules in order. prepend puts its rules first and drops the old rules with the same match, so a
// second run changes nothing.
// policy, prepend and add make the config when it does not exist.
// untrusted sets "untrusted": true on a server, so each of its results reaches the model as untrusted text. false
// removes the key.
// share sets "share": true on a server, so every session uses one copy of it through the broker (when the share switch
// is on). false removes the key, which leaves the server to the rules of its class.
// workspace prints the built-in Workspace section: its roots, grants and task names, and counts of its lists, never a
// task command, argument or variable. add puts a folder in workspace.roots under its real path, and makes the section
// and the config when they are missing. remove takes a root out with its grant and tasks, and the whole section when it
// was the last root. write sets "write": true on a root, and false removes the key. task sets a named task of a root
// from a JSON file. The server reads the section one time, at its start: restart the client after a change.
// To allow the exact tools of a task, run the lines that `toolscript-mcp tools` prints.
// Exit 1 is a failure of the config or the entry. Exit 2 is a usage error.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { ROOTS_MAX, TASKS_MAX, TASK_KEYS, TASK_NAME, commandProblem, isInside, rootProblem } from './roots.mjs'

const ACTIONS = ['allow', 'deny', 'ask']
const NAME = /^[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*$/
// The match rule of parsePolicy in src/core/config.ts. A policy error stops the server at its start.
const MATCH = /^(mcp__|\*)/

class Fail extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

// `missing`: the value when the file does not exist. Any other read error fails.
function readJson(file, what, missing) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' && missing !== undefined) return missing
    throw new Fail(`Cannot read ${what} ${file}: ${error.code ?? 'error'}.`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Fail(`The file ${file} is not valid JSON. config.mjs wrote nothing.`)
  }
}

function readConfig(file, missing) {
  const config = readJson(file, 'the config', missing)
  if (!isObject(config)) throw new Fail('The config must be a JSON object.')
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) {
    throw new Fail('The key mcpServers must be an object.')
  }
  return config
}

// configPath in src/core/config.ts.
function defaultPath() {
  const { env } = process
  if (env.TOOLSCRIPT_CONFIG) return env.TOOLSCRIPT_CONFIG
  const base =
    process.platform === 'win32'
      ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'toolscript-mcp', 'config.json').replaceAll('\\', '/')
}

function writeConfig(file, config) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw new Fail(`Cannot write the config: ${error.code ?? 'error'}.`)
  }
}

function describeServer(name, entry) {
  if (!isObject(entry)) return `${name}  invalid`
  return `${describeLink(name, entry)}${entry.untrusted === true ? '  untrusted' : ''}`
}

function describeLink(name, entry) {
  if (entry.type === 'http') {
    let origin = 'invalid-url'
    if (typeof entry.url === 'string' && entry.url.includes('${')) origin = 'url-from-a-variable'
    else {
      try {
        origin = new URL(entry.url).origin
      } catch {}
    }
    // A signed entry logs in with no OAuth. Print the label only: the profile and the region stay out of the line.
    if (isObject(entry.sigv4)) return `${name}  http  ${origin}  sigv4`
    const hasHeaders = isObject(entry.headers) && Object.keys(entry.headers).length > 0
    const oauth = isObject(entry.oauth) || entry.oauth === true || (!hasHeaders && entry.oauth !== false)
    return `${name}  http  ${origin}${oauth ? '  oauth' : ''}`
  }
  if (typeof entry.command === 'string') {
    // A command with a space can hold arguments, and so a secret.
    return /\s/.test(entry.command) ? `${name}  stdio` : `${name}  stdio  ${entry.command.split(/[\\/]/).pop()}`
  }
  return `${name}  invalid`
}

function show(config) {
  const lines = Object.entries(config.mcpServers ?? {}).map(([name, entry]) => describeServer(name, entry))
  const policy = Array.isArray(config.policy) ? config.policy : []
  if (policy.length === 0) {
    lines.push('policy: empty, so each tool is ask')
  } else {
    lines.push('policy:', ...policy.map(rule => JSON.stringify(rule)))
  }
  return lines.join('\n')
}

function usage() {
  throw new Fail(
    [
      'Usage:',
      '  node config.mjs path',
      '  node config.mjs <config>',
      '  node config.mjs <config> policy [<action> <match>]...',
      '  node config.mjs <config> prepend <action> <match> [<action> <match>]...',
      '  node config.mjs <config> add <name> <entry.json>',
      '  node config.mjs <config> untrusted <name> [true|false]',
      '  node config.mjs <config> share <name> [true|false]',
      '  node config.mjs <config> workspace',
      '  node config.mjs <config> workspace add <folder>',
      '  node config.mjs <config> workspace remove <folder>',
      '  node config.mjs <config> workspace write <folder> [true|false]',
      '  node config.mjs <config> workspace task <folder> <name> <task.json>',
    ].join('\n'),
    2,
  )
}

const newConfig = () => ({ mcpServers: {}, policy: [] })

const isRule = rule =>
  isObject(rule) &&
  Object.keys(rule).every(key => key === 'match' || key === 'action') &&
  typeof rule.match === 'string' &&
  MATCH.test(rule.match) &&
  ACTIONS.includes(rule.action)

// The old rules that prepend keeps. parsePolicy in src/core/config.ts refuses any other entry, and the server then
// does not start, so a bad entry fails here.
function oldRules(config) {
  if (config.policy === undefined) return []
  if (!Array.isArray(config.policy))
    throw new Fail('The key policy must be an array of rules. config.mjs wrote nothing.')
  const bad = config.policy.findIndex(rule => !isRule(rule))
  if (bad >= 0) {
    throw new Fail(
      `policy[${bad}] is not a rule such as {"match": "mcp__github__*", "action": "allow"}. config.mjs wrote nothing.`,
    )
  }
  return config.policy
}

function parseRules(args) {
  if (args.length % 2 !== 0) usage()
  const rules = []
  for (let i = 0; i < args.length; i += 2) {
    if (!ACTIONS.includes(args[i])) {
      throw new Fail(`The action must be allow, deny or ask, not "${args[i]}".`, 2)
    }
    if (!MATCH.test(args[i + 1])) {
      throw new Fail(`A match starts with mcp__ or *, such as mcp__github__*, not "${args[i + 1]}".`, 2)
    }
    rules.push({ match: args[i + 1], action: args[i] })
  }
  return rules
}

// ---------------------------------------------------------------------------------------------------------------
// The workspace commands

const NOTHING = 'config.mjs wrote nothing.'

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function showWorkspace(config) {
  const section = config.workspace
  if (section === undefined) return 'workspace: off'
  if (!isObject(section)) return 'workspace: invalid'
  const lines = []
  if (!Array.isArray(section.roots)) lines.push('roots: invalid')
  else {
    for (const entry of section.roots) {
      if (!isObject(entry) || typeof entry.path !== 'string') {
        lines.push('invalid root')
        continue
      }
      const parts = [JSON.stringify(entry.path), entry.write === true ? 'write' : 'read-only']
      if (entry.tasks !== undefined) {
        if (!isObject(entry.tasks)) parts.push('tasks: invalid')
        else {
          const names = Object.keys(entry.tasks)
          const good = names.filter(name => TASK_NAME.test(name))
          const bad = names.length - good.length
          const listed = [...good, ...(bad > 0 ? [plural(bad, 'invalid name', 'invalid names')] : [])]
          if (listed.length > 0) parts.push(`tasks: ${listed.join(', ')}`)
        }
      }
      lines.push(parts.join('  '))
    }
  }
  if (section.exclude !== undefined)
    lines.push(
      Array.isArray(section.exclude)
        ? `exclude: ${plural(section.exclude.length, 'glob', 'globs')}`
        : 'exclude: invalid',
    )
  if (section.skip !== undefined)
    lines.push(Array.isArray(section.skip) ? `skip: ${plural(section.skip.length, 'name', 'names')}` : 'skip: invalid')
  return lines.join('\n')
}

// The roots array when the section is one that this helper can change, else a failure that names the key.
function workspaceRoots(config) {
  const section = config.workspace
  if (!isObject(section)) throw new Fail(`The key workspace must be an object. ${NOTHING}`)
  if (!Array.isArray(section.roots)) throw new Fail(`The key workspace.roots must be an array. ${NOTHING}`)
  const bad = section.roots.findIndex(entry => !isObject(entry) || typeof entry.path !== 'string')
  if (bad >= 0) throw new Fail(`workspace.roots[${bad}] must be an object with a string "path". ${NOTHING}`)
  return section.roots
}

// On Windows a path is written with /, and \ separates parts. Elsewhere \ is a letter of a name.
const slashes = text => (process.platform === 'win32' ? text.replaceAll('\\', '/') : text)

// The real path of a folder that exists, written with /. Else undefined.
function realFolder(text) {
  try {
    return slashes(fs.realpathSync.native(text))
  } catch {
    return undefined
  }
}

// The path of a root entry or of a folder argument, as roots compare: its real path, or its text when it does not
// resolve (a missing folder, or a ${NAME} variable), with \ as /.
const rootKey = text => (text.includes('${') ? undefined : realFolder(text)) ?? slashes(text)

const sameRoot = (a, b) => isInside(a, b, process.platform) && isInside(b, a, process.platform)

function findRoot(roots, folder) {
  const key = rootKey(folder)
  const index = roots.findIndex(entry => sameRoot(rootKey(entry.path), key))
  if (index < 0) throw new Fail(`The config has no such workspace root. ${NOTHING}`)
  return index
}

function homeReal() {
  return realFolder(os.homedir()) ?? os.homedir()
}

function addRoot(config, folder) {
  const { platform } = process
  const absolute = platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(folder) : folder.startsWith('/')
  if (!absolute || folder.includes('${')) {
    throw new Fail(`The folder must be an absolute path with no \${ in it. ${NOTHING}`)
  }
  let real
  try {
    real = fs.realpathSync.native(folder)
    if (!fs.statSync(real).isDirectory()) real = undefined
  } catch {
    real = undefined
  }
  if (real === undefined) throw new Fail(`The folder does not exist, or it is not a folder. ${NOTHING}`)
  real = slashes(real)
  const problem = rootProblem(real, homeReal(), platform)
  if (problem !== undefined) throw new Fail(`The folder is refused: ${problem}. ${NOTHING}`)
  if (Object.hasOwn(config.mcpServers ?? {}, 'workspace')) {
    throw new Fail(
      `The config has an mcpServers entry with the key workspace, which the built-in Workspace uses. Rename the server first. ${NOTHING}`,
    )
  }
  const roots = config.workspace === undefined ? [] : workspaceRoots(config)
  const known = roots.map(entry => rootKey(entry.path))
  if (known.some(key => sameRoot(key, real))) return { notes: ['already a root'], changed: false }
  if (roots.length >= ROOTS_MAX) throw new Fail(`The section already has ${ROOTS_MAX} roots, the limit. ${NOTHING}`)
  const notes = []
  if (known.some(key => isInside(real, key, platform)))
    notes.push('Note: the new root is inside a root that exists. The deepest root gives the grants.')
  if (known.some(key => isInside(key, real, platform)))
    notes.push('Note: the new root holds a root that exists. The deepest root gives the grants.')
  if (config.workspace === undefined) config.workspace = { roots }
  roots.push({ path: real })
  return { notes, changed: true }
}

// sandbox.callTimeoutSeconds, or its default: the lesser of 60 and sandbox.timeoutSeconds (default 120).
function callTimeout(config) {
  const sandbox = isObject(config.sandbox) ? config.sandbox : {}
  if (Number.isInteger(sandbox.callTimeoutSeconds)) return sandbox.callTimeoutSeconds
  return Math.min(60, Number.isInteger(sandbox.timeoutSeconds) ? sandbox.timeoutSeconds : 120)
}

function taskEntry(file, config) {
  const task = readJson(file, 'the task')
  if (!isObject(task) || typeof task.command !== 'string' || task.command === '') {
    throw new Fail('The task file must be an object with a non-empty string "command".')
  }
  const problem = commandProblem(task.command, process.platform === 'win32')
  if (problem !== undefined) throw new Fail(`The key command of the task file ${problem}. ${NOTHING}`)
  const limit = callTimeout(config)
  const t = task.timeoutSeconds
  if (t !== undefined && !(Number.isInteger(t) && t >= 1 && t <= limit)) {
    throw new Fail(
      `The key timeoutSeconds must be a whole number from 1 to ${limit}, the value of sandbox.callTimeoutSeconds. ${NOTHING}`,
    )
  }
  const unknown = Object.keys(task).find(key => !TASK_KEYS.includes(key))
  if (unknown !== undefined) {
    throw new Fail(`The task file has a key that is not one of ${TASK_KEYS.join(', ')}.`)
  }
  if (task.args !== undefined && (!Array.isArray(task.args) || task.args.some(a => typeof a !== 'string'))) {
    throw new Fail('The key args of the task file must be a list of strings.')
  }
  return task
}

function workspaceCommand(file, args) {
  const [sub, ...rest] = args
  if (sub === undefined) {
    return showWorkspace(readConfig(file))
  }
  const counts = { add: [1], remove: [1], write: [1, 2], task: [3] }
  if (!Object.hasOwn(counts, sub) || !counts[sub].includes(rest.length)) usage()
  const [folder, extra, taskFile] = rest
  if (sub === 'write' && extra !== undefined && !['true', 'false'].includes(extra)) usage()
  const config = readConfig(file, sub === 'add' ? newConfig() : undefined)
  const lines = []
  if (sub === 'add') {
    const result = addRoot(config, folder)
    lines.push(...result.notes)
    if (!result.changed) return lines.join('\n')
  } else {
    const roots = workspaceRoots(config)
    const index = findRoot(roots, folder)
    const entry = roots[index]
    if (sub === 'remove') {
      roots.splice(index, 1)
      if (roots.length === 0) delete config.workspace
    } else if (sub === 'write') {
      if ((extra ?? 'true') === 'true') entry.write = true
      else delete entry.write
    } else {
      if (!TASK_NAME.test(extra)) {
        throw new Fail(`The task name must have 1 to 32 characters from a-z, 0-9, - and _. ${NOTHING}`)
      }
      if (entry.tasks !== undefined && !isObject(entry.tasks)) {
        throw new Fail(`The key tasks of the root must be an object. ${NOTHING}`)
      }
      const task = taskEntry(taskFile, config)
      const tasks = entry.tasks ?? {}
      const replaced = Object.hasOwn(tasks, extra)
      if (!replaced && Object.keys(tasks).length >= TASKS_MAX) {
        throw new Fail(`The root has ${TASKS_MAX} tasks already, the limit. ${NOTHING}`)
      }
      // defineProperty: the name __proto__ fits TASK_NAME, and an assignment would not make a key.
      Object.defineProperty(tasks, extra, { value: task, enumerable: true, writable: true, configurable: true })
      entry.tasks = tasks
      lines.push(replaced ? `Replaced the task "${extra}".` : `Set the task "${extra}".`)
    }
  }
  writeConfig(file, config)
  return [...lines, showWorkspace(config)].join('\n')
}

const COMMANDS = {
  workspace: workspaceCommand,
  show(file, args) {
    if (args.length > 0) usage()
    return show(readConfig(file))
  },
  policy(file, args) {
    const rules = parseRules(args)
    const config = readConfig(file, newConfig())
    config.policy = rules
    writeConfig(file, config)
    return show(config)
  },
  prepend(file, args) {
    if (args.length === 0) usage()
    const rules = parseRules(args)
    const config = readConfig(file, newConfig())
    const matches = new Set(rules.map(rule => rule.match))
    config.policy = [...rules, ...oldRules(config).filter(rule => !matches.has(rule.match))]
    writeConfig(file, config)
    return show(config)
  },
  add(file, args) {
    if (args.length !== 2) usage()
    const [name, entryFile] = args
    if (!NAME.test(name)) {
      throw new Fail(`The name "${name}" is not valid. Use letters, digits, - and _ between parts.`)
    }
    const config = readConfig(file, newConfig())
    if (Object.hasOwn(config.mcpServers ?? {}, name)) {
      throw new Fail(`The server "${name}" exists already. config.mjs wrote nothing.`)
    }
    const entry = readJson(entryFile, 'the entry')
    const stdio = isObject(entry) && typeof entry.command === 'string'
    const http = isObject(entry) && entry.type === 'http' && typeof entry.url === 'string'
    if (!stdio && !http) {
      throw new Fail('The entry must be an object with a string "command", or with "type": "http" and a string "url".')
    }
    config.mcpServers = { ...config.mcpServers, [name]: entry }
    writeConfig(file, config)
    return show(config)
  },
  untrusted(file, args) {
    const [name, value = 'true', ...more] = args
    if (name === undefined || more.length > 0 || !['true', 'false'].includes(value)) usage()
    const config = readConfig(file)
    const entry = config.mcpServers?.[name]
    if (!Object.hasOwn(config.mcpServers ?? {}, name) || !isObject(entry)) {
      throw new Fail(`The config has no server "${name}". config.mjs wrote nothing.`)
    }
    if (value === 'true') entry.untrusted = true
    else delete entry.untrusted
    writeConfig(file, config)
    return show(config)
  },
  share(file, args) {
    const [name, value = 'true', ...more] = args
    if (name === undefined || more.length > 0 || !['true', 'false'].includes(value)) usage()
    const config = readConfig(file)
    const entry = config.mcpServers?.[name]
    if (!Object.hasOwn(config.mcpServers ?? {}, name) || !isObject(entry)) {
      throw new Fail(`The config has no server "${name}". config.mjs wrote nothing.`)
    }
    if (value === 'true') entry.share = true
    else delete entry.share
    writeConfig(file, config)
    return show(config)
  },
}

function main(argv) {
  if (argv.length === 1 && argv[0] === 'path') return defaultPath()
  const [file, name = 'show', ...args] = argv
  if (!file || !Object.hasOwn(COMMANDS, name)) usage()
  return COMMANDS[name](file, args)
}

try {
  console.log(main(process.argv.slice(2)))
} catch (error) {
  if (!(error instanceof Fail)) throw error
  console.error(error.message)
  process.exit(error.code)
}

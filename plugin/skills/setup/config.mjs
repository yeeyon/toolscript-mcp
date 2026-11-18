// Shows and changes the toolscript-mcp config file without printing a secret.
// It never prints args, env, headers, OAuth values or a URL path, query or login.
// Usage:
//   node config.mjs path
//   node config.mjs <config>
//   node config.mjs <config> policy [<action> <match>]...
//   node config.mjs <config> prepend <action> <match> [<action> <match>]...
//   node config.mjs <config> add <name> <entry.json>
// path prints the default config path, as toolscript-mcp finds it without --config.
// policy writes the rules in order. prepend puts its rules first and drops the old rules with the same match, so a
// second run changes nothing.
// policy, prepend and add make the config when it does not exist.
// Exit 1 is a failure of the config or the entry. Exit 2 is a usage error.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

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
  if (entry.type === 'http') {
    let origin = 'invalid-url'
    if (typeof entry.url === 'string' && entry.url.includes('${')) origin = 'url-from-a-variable'
    else {
      try {
        origin = new URL(entry.url).origin
      } catch {}
    }
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

const COMMANDS = {
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

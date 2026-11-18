// How this process started and the config that it reads, for the server and the commands of the CLI.

import fs from 'node:fs'
import path from 'node:path'
import {
  configPath,
  loginCommand,
  NPX_LAUNCH,
  parseConfig,
  type Config,
  type Env,
  type Launch,
  type ServerKey,
} from '../core/config.ts'
import { errorText } from '../core/protocol.ts'

// The package folder or its bin shim, inside node_modules: an npx cache or an npm install.
const FROM_NPM = /[\\/]node_modules[\\/](\.bin[\\/])?toolscript-mcp([\\/]|$)/i

/** `npx -y toolscript-mcp` when `script` is in an npm install, else `node <absolute path of script>`, as in a clone. */
export const detectLaunch = (script: string): Launch =>
  FROM_NPM.test(script) ? NPX_LAUNCH : { kind: 'node', main: path.resolve(script) }

/** The config in `file`, or the lines that say why it cannot be read. */
export const loadConfig = (
  file: string,
  env: Env,
  platform: string,
): { readonly ok: true; readonly config: Config } | { readonly ok: false; readonly lines: readonly string[] } => {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, lines: [`cannot read the config ${file}: ${errorText(err)}`] }
  }
  const parsed = parseConfig(text, env, process.execPath, platform)
  return parsed.ok
    ? parsed
    : { ok: false, lines: [`the config ${file} has errors:`, ...parsed.errors.map(e => `  ${e}`)] }
}

/**
 * The login command of a server of the config `file`. The person runs login in a terminal, without the flag or the
 * TOOLSCRIPT_CONFIG of this process, so the command names `file` when it is not the usual config.
 */
export const loginFor = (
  launch: Launch,
  file: string,
  env: Env,
  platform: string,
  home: string,
): ((key: ServerKey) => string) => {
  const usual = configPath(undefined, { ...env, TOOLSCRIPT_CONFIG: undefined }, platform, home)
  const other = path.resolve(file) === path.resolve(usual) ? undefined : path.resolve(file)
  return key => loginCommand(launch, platform, key, other)
}

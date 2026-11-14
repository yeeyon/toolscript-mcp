// `toolscript-mcp init`: reads the MCP servers of the clients, writes the
// toolscript-mcp config with mode 0600 and prints what to change in each
// client. It never writes a client file. It prints to stderr, as the server
// does: the text is for a person, and the config file is the output.

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { configPath, type Env } from '../core/config.ts'
import { clientFiles, configText, importServers, initReport, type ClientFile, type ClientRead } from '../core/init.ts'
import { errorText } from '../core/protocol.ts'

export const INIT_USAGE = 'usage: toolscript-mcp init [--config <path>] [--force] [--dry-run]'

const readClient = async (file: ClientFile): Promise<ClientRead> => {
  const at = { client: file.client, path: path.resolve(file.path) }
  try {
    return { ...at, kind: 'text', text: await fs.promises.readFile(at.path, 'utf8') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...at, kind: 'missing' }
    return { ...at, kind: 'unreadable', error: errorText(err) }
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

  if (options['dry-run']) {
    const exists = fs.existsSync(file) ? ` ${file} exists, so init refuses to replace it without --force.` : ''
    print(
      [
        `Dry run: init writes nothing. It would write this config to ${file}.${exists}`,
        'The values of env and headers, and the user, password and query of URLs, show as ***.',
        '',
        configText(imported.servers, true),
        report,
      ].join('\n'),
    )
    return 0
  }

  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    // The config holds the env and header values of the servers: only the user reads it.
    await fs.promises.writeFile(file, configText(imported.servers, false), {
      mode: 0o600,
      flag: options.force ? 'w' : 'wx',
    })
    // A file that --force replaces keeps its old mode.
    await fs.promises.chmod(file, 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      print(`${file} exists. init did not change it. To replace it, run init again with --force.`)
      return 1
    }
    print(`cannot write ${file}: ${errorText(err)}`)
    return 1
  }
  print(`Wrote ${file}.\n\n${report}`)
  return 0
}

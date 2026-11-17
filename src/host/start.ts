// How this process started, for the commands that the CLI prints.

import path from 'node:path'
import { NPX_LAUNCH, type Launch } from '../core/config.ts'

// The package folder or its bin shim, inside node_modules: an npx cache or an npm install.
const FROM_NPM = /[\\/]node_modules[\\/](\.bin[\\/])?toolscript-mcp([\\/]|$)/i

/** `npx -y toolscript-mcp` when `script` is in an npm install, else `node <absolute path of script>`, as in a clone. */
export const detectLaunch = (script: string): Launch =>
  FROM_NPM.test(script) ? NPX_LAUNCH : { command: 'node', args: [path.resolve(script)] }

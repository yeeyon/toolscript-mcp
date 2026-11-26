import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const MAIN = fileURLToPath(new URL('../src/host/main.ts', import.meta.url))
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('toolscript-mcp --version', () => {
  for (const flag of ['--version', '-v']) {
    it(`${flag} prints the package version on one line and reads no config`, () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'version-'))
      try {
        // A config that is not valid JSON would fail a start: the flag must not read it.
        const config = path.join(home, 'config.json')
        fs.writeFileSync(config, '{ not json')
        const result = spawnSync(process.execPath, ['--experimental-strip-types', MAIN, flag], {
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, TOOLSCRIPT_CONFIG: config, HOME: home, USERPROFILE: home, APPDATA: home },
        })
        assert.equal(result.status, 0)
        assert.equal(result.stdout, `${version}\n`)
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    })
  }
})

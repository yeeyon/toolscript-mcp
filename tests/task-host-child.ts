// A host process for the hard-kill test (issue #149): it runs one task with the real helper of this OS and waits. The
// test kills it with SIGKILL, and then checks that no process of the task stays. It ends by itself in 120 s.
import path from 'node:path'
import { createTaskRunner } from '../src/host/workspace/task.ts'

const [dir, mode] = process.argv.slice(2) as [string, string]
const runner = createTaskRunner({
  valid: [
    {
      name: 'x',
      file: process.execPath,
      args: [path.join(import.meta.dirname, 'task-child.mjs'), 'orphan', dir, mode],
      cwd: dir,
      timeoutMs: 120_000,
      env: { ...process.env } as Record<string, string>,
      proveCwd: async () => {},
    },
  ],
  invalid: [],
})
runner
  .run('x', new AbortController().signal)
  .catch(error => process.stderr.write(`run failed: ${(error as Error).message}\n`))
setTimeout(() => process.exit(0), 120_000)

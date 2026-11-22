// The entry of dist/host/broker.js: starts the broker of this user and build, and leaves when it is empty or told to.
// A broker that loses the listen race exits 0. It has no stdout and no stderr (the host starts it with stdio ignored).

import os from 'node:os'
import { idleMs } from '../core/broker.ts'
import { startBroker } from './broker.ts'

const file = process.argv[1]
const broker =
  file === undefined
    ? undefined
    : await startBroker({
        home: os.homedir(),
        idleMs: idleMs(process.env.TOOLSCRIPT_BROKER_IDLE_MS),
        file,
      }).catch(() => undefined)
if (broker === undefined) process.exit(0)

const leave = () => void broker.stop()
process.on('SIGTERM', leave)
process.on('SIGINT', leave)
// A crash would end the broker with no line: its stderr goes nowhere. The line holds the class and code of the error,
// never its message, which can hold a path or a value. The children see the end of their stdin.
const crash = (err: unknown): never => {
  const { name, code } = (typeof err === 'object' && err !== null ? err : {}) as { name?: unknown; code?: unknown }
  const word = (v: unknown, fallback: string) => (typeof v === 'string' && /^\w{1,40}$/.test(v) ? v : fallback)
  broker.log(`crash ${word(name, 'Error')} ${word(code, '-')}`)
  process.exit(1)
}
process.on('uncaughtException', crash)
process.on('unhandledRejection', crash)
await broker.done
process.exit(0)

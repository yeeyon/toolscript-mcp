// A child of tests/shapes.test.ts: 20 writes of the shapes file, each with all the keys of this writer so far.
//
//   node tests/shapes-writer.mjs <home> <id>

import { saveShapes } from '../src/host/shapes.ts'

const [home, id] = process.argv.slice(2)
const learned = new Map()
let failed = 0
for (let n = 0; n < 20; n++) {
  learned.set(`mcp__w${id}__t${n}`, { shape: '{a, b: {c}}', schema: '0123456789abcdef' })
  await saveShapes(home, learned, line => {
    failed++
    console.error(line)
  })
}
process.exitCode = failed > 0 ? 3 : 0

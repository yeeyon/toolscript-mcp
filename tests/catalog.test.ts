import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  argsText,
  argSpec,
  learnShape,
  searchResult,
  type DownstreamTool,
  type ServerState,
} from '../src/core/catalog.ts'
import { serverKey } from '../src/core/config.ts'
import { checkCalls } from '../src/core/protocol.ts'

const server = (tools: DownstreamTool[]): ServerState[] => [{ key: serverKey('x')!, status: 'connected', tools }]
// The full name of the tool ranks it first, so the one tool is a hit in full. An empty query shows a summary.
const one = (tool: DownstreamTool, shapes?: Map<string, string>): string =>
  searchResult(server([tool]), `mcp__x__${tool.name}`, 15, shapes).replace(/^1 of 1 MCP tools\.\n\n/, '')

describe('search_tools with no match', () => {
  const tools = [{ name: 'grant', description: 'Grant access.' }]

  test('a short query is echoed whole', () => {
    assert.equal(
      searchResult(server(tools), 'zzzqq', 15),
      'No MCP tool matches "zzzqq". 1 MCP tools are connected. An empty query lists them.',
    )
  })

  // #49 review: "mcp" is no longer a word of every tool name, so a model that searched it to list all needs the way out.
  test('a search for "mcp" finds no tool and names the empty query', () => {
    assert.match(searchResult(server(tools), 'mcp', 15), /^No MCP tool matches "mcp"\. .* An empty query lists them\.$/)
  })

  test('with no tool connected, the text names no empty query', () => {
    assert.equal(searchResult([], 'zzzqq', 15), 'No MCP tool matches "zzzqq". 0 MCP tools are connected.')
  })

  test('a long query is cut to 200 characters and its length is named', () => {
    const query = 'zzz '.repeat(1250)
    assert.equal(
      searchResult(server(tools), query, 15),
      `No MCP tool matches "${query.slice(0, 200)}... (5000 characters)". 1 MCP tools are connected. An empty query lists them.`,
    )
  })
})

describe('search_tools and a tool whose server requires a person', () => {
  const MARK = { 'anthropic/requiresUserInteraction': true }
  const NOTE = 'A person approves each run that calls it. Write its name as a string in call("…").'

  test('a hit in full says so, and an unmarked one does not', () => {
    assert.equal(
      one({ name: 'grant', description: 'Grant access.', _meta: MARK }),
      ['### mcp__x__grant', 'Grant access.', NOTE, 'call("mcp__x__grant", {})'].join('\n'),
    )
    assert.ok(!one({ name: 'grant', description: 'Grant access.' }).includes(NOTE))
  })

  test('with a client that cannot ask, the note says that a program cannot call it', () => {
    const text = searchResult(
      server([{ name: 'grant', description: 'Grant access.', _meta: MARK }]),
      '',
      15,
      new Map(),
      false,
    )
    assert.ok(
      text.includes(
        'A person approves each run that calls it. This MCP client cannot ask the person, so a program cannot call it.',
      ),
      text,
    )
    assert.ok(!text.includes('Write its name as a string'), text)
  })

  test('a hit on one line among many says so too', () => {
    const tools = ['a', 'b', 'c', 'd'].map(name => ({
      name: `grant_${name}`,
      description: 'Grant access.',
      ...(name === 'b' ? { _meta: MARK } : {}),
    }))
    const blocks = searchResult(server(tools), 'grant', 15).split('\n### ').slice(1)
    assert.deepEqual(
      blocks.map(b => b.includes(NOTE)),
      [false, true, false, false],
      blocks.join('\n### '),
    )
  })
})

describe('search_tools with 3 or fewer hits', () => {
  test('shows the full description and a call() declaration with nested types, enums and argument notes', () => {
    const text = one({
      name: 'search',
      description: 'Search issues.\n\n  Second line.',
      inputSchema: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'JQL query' },
          max: { type: 'integer' },
          order: { enum: ['asc', 'desc'], description: 'Sort order.' },
          fields: {
            type: 'array',
            description: 'Fields to return.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, kind: { type: ['string', 'null'] } },
              required: ['name'],
            },
          },
          ids: { type: 'array', items: { type: ['string', 'number'] } },
          labels: { type: 'object', additionalProperties: { type: 'string' } },
          extra: { type: 'object' },
          'odd-name': { type: 'boolean' },
        },
        required: ['jql'],
      },
      outputSchema: {
        type: 'object',
        properties: { issues: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' } } } } },
        required: ['issues'],
      },
    })
    assert.equal(
      text,
      [
        '### mcp__x__search',
        'Search issues. Second line.',
        'call("mcp__x__search", {',
        '  jql: string // JQL query',
        '  max?: number',
        '  order?: "asc" | "desc" // Sort order.',
        '  fields?: { // Fields to return.',
        '    name: string',
        '    kind?: string | null',
        '  }[]',
        '  ids?: (string | number)[]',
        '  labels?: { [key: string]: string }',
        '  extra?: object',
        '  "odd-name"?: boolean',
        '}): Promise<{',
        '  issues: {',
        '    key?: string',
        '  }[]',
        '}>',
      ].join('\n'),
    )
  })

  test('a tool with no arguments shows {}', () => {
    assert.equal(one({ name: 'ping' }), '### mcp__x__ping\ncall("mcp__x__ping", {})')
    assert.equal(
      one({ name: 'ping', description: 'Ping.', inputSchema: { type: 'object' } }),
      '### mcp__x__ping\nPing.\ncall("mcp__x__ping", {})',
    )
  })

  test('follows local $ref, anyOf and oneOf, and stops at a cycle or a ref it cannot read', () => {
    const text = one({
      name: 'find',
      inputSchema: {
        type: 'object',
        $defs: {
          Filter: { type: 'object', properties: { q: { type: 'string' } } },
          Loop: { $ref: '#/$defs/Loop' },
        },
        properties: {
          filter: { $ref: '#/$defs/Filter', description: 'The filter.' },
          again: { anyOf: [{ $ref: '#/$defs/Filter' }, { type: 'null' }] },
          mode: { oneOf: [{ const: 'fast' }, { const: 'full' }] },
          loop: { $ref: '#/$defs/Loop' },
          remote: { $ref: 'https://example.com/schema.json' },
          missing: { $ref: '#/$defs/Nope' },
        },
      },
    })
    assert.equal(
      text,
      [
        '### mcp__x__find',
        'call("mcp__x__find", {',
        '  filter?: { // The filter.',
        '    q?: string',
        '  }',
        '  again?: {',
        '    q?: string',
        '  } | null',
        '  mode?: "fast" | "full"',
        '  loop?: unknown',
        '  remote?: unknown',
        '  missing?: unknown',
        '})',
      ].join('\n'),
    )
  })

  test('shows objects to 3 levels and a recursive type no deeper', () => {
    const text = one({
      name: 'tree',
      inputSchema: {
        type: 'object',
        definitions: {
          Node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/definitions/Node' } } } },
        },
        properties: { root: { $ref: '#/definitions/Node' } },
      },
    })
    assert.equal(
      text,
      [
        '### mcp__x__tree',
        'call("mcp__x__tree", {',
        '  root?: {',
        '    children?: {',
        '      children?: object[]',
        '    }[]',
        '  }',
        '})',
      ].join('\n'),
    )
  })

  test('a long enum shows its first 25 values', () => {
    const values = Array.from({ length: 40 }, (_, i) => `v${i}`)
    const text = one({ name: 'e', inputSchema: { type: 'object', properties: { v: { enum: values } } } })
    assert.ok(text.includes('"v24" | …\n'), text)
    assert.ok(!text.includes('"v25"'), text)
  })

  test('a declaration too large to show drops the nested types first, then the notes', () => {
    const note = 'A note of about one hundred characters, which the model reads to fill in this argument right.'
    const wide = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`f${i}`, { type: 'string', description: note }]),
    )
    const nested = one({
      name: 'nested',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'object', properties: wide }, b: { type: 'string', description: 'B.' } },
      },
    })
    assert.equal(nested, '### mcp__x__nested\ncall("mcp__x__nested", {\n  a?: object\n  b?: string // B.\n})')

    const flat = one({
      name: 'flat',
      inputSchema: { type: 'object', properties: wide, required: ['f59'] },
      outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    })
    const lines = Array.from({ length: 59 }, (_, i) => `  f${i}?: string`)
    assert.equal(flat, ['### mcp__x__flat', 'call("mcp__x__flat", {', '  f59: string', ...lines, '})'].join('\n'))
  })

  test('a large flat tool without room for its notes shows every argument, the required ones first', () => {
    const note = 'n'.repeat(150)
    const properties = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`option_${i}`, { enum: ['alpha', 'beta', 'gamma'], description: note }]),
    )
    const text = one({ name: 'big', inputSchema: { type: 'object', properties, required: ['option_39'] } })
    const optional = Array.from({ length: 39 }, (_, i) => `  option_${i}?: "alpha" | "beta" | "gamma"`)
    assert.equal(
      text,
      ['### mcp__x__big', 'call("mcp__x__big", {', '  option_39: "alpha" | "beta" | "gamma"', ...optional, '})'].join(
        '\n',
      ),
    )
  })

  test('arguments too many to show keep the required ones and count the rest', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [`argument_number_${i}`, { type: 'string' }]),
    )
    const text = one({ name: 'wide', inputSchema: { type: 'object', properties, required: ['argument_number_149'] } })
    const prefix = '### mcp__x__wide\ncall("mcp__x__wide", { '
    assert.ok(text.startsWith(prefix) && text.endsWith(' })'), text)
    const args = text.slice(prefix.length - 2, -1)
    assert.ok(args.length <= 500, `${args.length} characters`)
    const parts = text.slice(prefix.length, -3).split('; ')
    const left = Number(/^… (\d+) more arguments$/.exec(parts.pop()!)?.[1])
    assert.equal(parts[0], 'argument_number_149: string', text)
    parts.slice(1).forEach((p, i) => assert.equal(p, `argument_number_${i}?: string`))
    assert.ok(parts.length > 1, text)
    assert.equal(parts.length + left, 150, text)
    assert.match(
      argsText({ type: 'object', properties }),
      /^\{ argument_number_0\?: string; .+; … \d+ more arguments \}$/,
    )
  })

  test('the declaration of a tool shows the numeric bounds of a number', () => {
    const inputSchema = {
      type: 'object',
      properties: {
        maxResults: { type: 'integer', maximum: 100 },
        page: { type: 'integer', minimum: 1, maximum: 50 },
        floor: { type: 'number', minimum: 0.5 },
        mixed: { type: ['number', 'null'], maximum: 9 },
        loose: { type: 'number', maximum: '100', exclusiveMinimum: 0 },
        ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
      },
    }
    assert.equal(
      one({ name: 'b', inputSchema }),
      [
        '### mcp__x__b',
        'call("mcp__x__b", {',
        '  maxResults?: number (max 100)',
        '  page?: number (1-50)',
        '  floor?: number (min 0.5)',
        '  mixed?: number (max 9) | null',
        '  loose?: number',
        '  ids?: (number (min 1))[]',
        '})',
      ].join('\n'),
    )
  })

  test('a cut list of values keeps the null and the types of the union in both views', () => {
    const values = Array.from({ length: 30 }, (_, i) => `z${i}`)
    const first = values.slice(0, 25).map(v => `"${v}"`)
    for (const [other, end] of [
      [{ type: 'null' }, 'null'],
      [{ type: 'string' }, 'string'],
    ] as const) {
      const inputSchema = { type: 'object', properties: { tz: { anyOf: [{ enum: values }, other] } } }
      const type = [...first, '…', end].join(' | ')
      assert.equal(argsText(inputSchema), `{ tz?: ${type} }`)
      assert.equal(one({ name: 'u', inputSchema }), `### mcp__x__u\ncall("mcp__x__u", {\n  tz?: ${type}\n})`)
    }
  })

  test('the detail view shows every member of a long union, and the short list its first 25 values', () => {
    const variants = Array.from({ length: 30 }, (_, i) => ({
      type: 'object',
      required: ['action'],
      properties: { action: { const: `act_${i}` }, id: { type: 'string' } },
    }))
    const detail = one({
      name: 'v',
      inputSchema: { type: 'object', required: ['op'], properties: { op: { anyOf: variants } } },
    })
    assert.ok(detail.includes('action: "act_29"') && !detail.includes('…'), detail)
    const consts = {
      type: 'object',
      properties: { n: { anyOf: Array.from({ length: 30 }, (_, i) => ({ const: `v${i}` })) } },
    }
    assert.ok(one({ name: 'c', inputSchema: consts }).includes('"v28" | "v29"'))
    assert.match(argsText(consts), /"v24" \| … \}$/)
  })

  test('the detail view marks each cut enum of a union, and the short list marks its cut once', () => {
    const values = (p: string): { enum: string[] } => ({ enum: Array.from({ length: 30 }, (_, i) => `${p}${i}`) })
    const inputSchema = { type: 'object', properties: { n: { anyOf: [values('a'), values('b')] } } }
    const detail = one({ name: 'u', inputSchema })
    assert.ok(detail.includes('"a24" | … | "b0"') && detail.endsWith('"b24" | …\n})'), detail)
    assert.match(argsText(inputSchema), /"a24" \| … \}$/)
  })

  test('a union or a $ref next to a type keeps the type', () => {
    const inputSchema = {
      type: 'object',
      $defs: { Sha: { pattern: '^[0-9a-f]{40}$', description: 'A commit' }, Mode: { enum: ['a', 'b'] } },
      required: ['q', 'when', 'sha'],
      properties: {
        q: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'number' } },
          oneOf: [{ required: ['a'] }, { required: ['b'] }],
        },
        when: { type: 'string', anyOf: [{ format: 'date' }, { format: 'date-time' }] },
        sha: { type: 'string', $ref: '#/$defs/Sha' },
        mode: { type: 'string', $ref: '#/$defs/Mode' },
      },
    }
    assert.equal(
      one({ name: 't', inputSchema }),
      [
        '### mcp__x__t',
        'call("mcp__x__t", {',
        '  q: {',
        '    a?: string',
        '    b?: number',
        '  }',
        '  when: string',
        '  sha: string // A commit',
        '  mode?: string & ("a" | "b")',
        '})',
      ].join('\n'),
    )
  })

  test('an empty enum shows never and an empty type list shows unknown', () => {
    const inputSchema = { type: 'object', properties: { a: { enum: [] }, b: { type: [] } } }
    assert.equal(one({ name: 'e', inputSchema }), '### mcp__x__e\ncall("mcp__x__e", {\n  a?: never\n  b?: unknown\n})')
    assert.equal(argsText(inputSchema), '{ a?: never; b?: unknown }')
  })

  test('an array or union that holds itself with no object between stops', () => {
    const text = one({
      name: 'self',
      inputSchema: {
        type: 'object',
        $defs: { List: { type: 'array', items: { $ref: '#/$defs/List' } }, Any: { anyOf: [{ $ref: '#/$defs/Any' }] } },
        properties: { list: { $ref: '#/$defs/List' }, any: { $ref: '#/$defs/Any' } },
      },
    })
    assert.match(text, /\n {2}list\?: unknown(\[\])+\n {2}any\?: unknown\n\}\)$/)
    assert.ok(text.length < 200, text)
  })

  test('an allOf next to properties shows both, so a required argument stays required', () => {
    const text = one({
      name: 'q',
      inputSchema: {
        type: 'object',
        $defs: { Paging: { type: 'object', properties: { limit: { type: 'integer' } } } },
        properties: {
          query: { type: 'string' },
          paging: { allOf: [{ $ref: '#/$defs/Paging' }], description: 'Paging.' },
          sort: {
            properties: { by: { type: 'string' } },
            required: ['by'],
            allOf: [{ $ref: '#/$defs/Paging' }, { properties: { desc: { type: 'boolean' } } }],
          },
        },
        required: ['query'],
        allOf: [{ properties: { limit: { type: 'integer' } } }],
      },
    })
    assert.equal(
      text,
      [
        '### mcp__x__q',
        'call("mcp__x__q", {',
        '  query: string',
        '  paging?: { // Paging.',
        '    limit?: number',
        '  }',
        '  sort?: {',
        '    by: string',
        '  } & {',
        '    limit?: number',
        '  } & {',
        '    desc?: boolean',
        '  }',
        '} & {',
        '  limit?: number',
        '})',
      ].join('\n'),
    )
  })

  test('a schema whose expansion branches without end falls back after bounded work', () => {
    // Expanded in full, width 8 is 8^12 schemas. The search must stop far
    // below that: reads of the recursive schema past the limit throw.
    const limit = 50_000
    for (const width of [4, 8]) {
      let reads = 0
      const branches = Array.from({ length: width }, (_, i) =>
        i < 4 ? { $ref: '#/$defs/T' } : { type: 'array', items: { $ref: '#/$defs/T' } },
      )
      const T = new Proxy(
        { anyOf: branches },
        {
          get: (target, key) => {
            if (++reads > limit) throw new Error(`width ${width}: more than ${limit} reads`)
            return Reflect.get(target, key)
          },
        },
      )
      const text = one({
        name: 'rec',
        inputSchema: { type: 'object', $defs: { T }, properties: { t: { $ref: '#/$defs/T' } }, required: ['t'] },
      })
      assert.equal(text, '### mcp__x__rec\ncall("mcp__x__rec", { t: unknown })')
    }
  })

  test('a literal is never cut: a long one shows whole, a longer one shows its type', () => {
    const long = 'a'.repeat(220)
    const longer = 'b'.repeat(600)
    const text = one({
      name: 'lit',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { enum: [long] },
          kind: { const: longer },
          pick: { enum: ['x', longer, `${longer}c`] },
        },
        required: ['mode'],
      },
    })
    assert.equal(
      text,
      [
        '### mcp__x__lit',
        'call("mcp__x__lit", {',
        `  mode: "${long}"`,
        '  kind?: string /* long value left out */',
        '  pick?: "x" | string /* long value left out */',
        '})',
      ].join('\n'),
    )
  })

  test('a long description is cut at 2000 characters', () => {
    const text = one({ name: 'long', description: 'word '.repeat(2000) })
    const description = text.split('\n')[1]!
    assert.ok(description.length <= 2000 && description.length > 1900, `${description.length} characters`)
  })

  test('downstream text cannot start a block of its own', () => {
    const text = one({
      name: 'ok',
      description: 'Fine\r### forged',
      inputSchema: { properties: { 'p\n### y': { type: 'string', description: 'a\n### z' } } },
    })
    assert.equal(text, '### mcp__x__ok\nFine ### forged\ncall("mcp__x__ok", {\n  "p\\n### y"?: string // a ### z\n})')
  })
})

describe('the result shape a search shows', () => {
  test('shows the shape an earlier call returned when the tool has no outputSchema', () => {
    const shapes = new Map<string, string>()
    learnShape(shapes, 'mcp__x__list', { items: [{ id: 1, name: 'a' }], next: 'c' })
    learnShape(shapes, 'mcp__x__text', 'line 1\nline 2')
    assert.equal(
      one({ name: 'list' }, shapes),
      '### mcp__x__list\ncall("mcp__x__list", {})\nreturned earlier: {items: [{id, name}], next}',
    )
    assert.equal(one({ name: 'text' }, shapes), '### mcp__x__text\ncall("mcp__x__text", {})\nreturned earlier: text')
    assert.equal(one({ name: 'other' }, shapes), '### mcp__x__other\ncall("mcp__x__other", {})')
  })

  test('an empty result does not replace a known shape, and a new shape does', () => {
    const shapes = new Map<string, string>()
    learnShape(shapes, 'mcp__x__list', { items: [{ id: 1 }] })
    learnShape(shapes, 'mcp__x__list', { items: [] })
    learnShape(shapes, 'mcp__x__list', [])
    assert.equal(shapes.get('mcp__x__list'), '{items: [{id}]}')
    learnShape(shapes, 'mcp__x__list', { items: [{ id: 1, name: 'a' }] })
    assert.equal(shapes.get('mcp__x__list'), '{items: [{id, name}]}')
  })

  test('the outputSchema wins over a shape seen earlier', () => {
    const shapes = new Map([['mcp__x__get', '{a}']])
    const text = one({ name: 'get', outputSchema: { type: 'object', properties: { b: { type: 'number' } } } }, shapes)
    assert.equal(text, '### mcp__x__get\ncall("mcp__x__get", {}): Promise<{\n  b?: number\n}>')
  })
})

describe('the argument check of a closed schema', () => {
  test('a schema that can name more arguments next to its properties allows other names', () => {
    const closed = { type: 'object', properties: { q: {} }, required: ['q'], additionalProperties: false }
    assert.equal(argSpec(closed)?.isOpen, false)
    for (const [key, value] of Object.entries({
      patternProperties: { '^x-': { type: 'string' } },
      if: { properties: { q: { const: 'a' } } },
      then: { properties: { extra: {} } },
      else: { properties: { extra: {} } },
      dependentSchemas: { q: { properties: { extra: {} } } },
      dependencies: { q: { properties: { extra: {} } } },
      $ref: '#/$defs/More',
    })) {
      assert.deepEqual(argSpec({ ...closed, [key]: value }), { names: ['q'], required: ['q'], isOpen: true }, key)
    }
  })

  test('a required argument that the properties leave out is no unknown argument', () => {
    const spec = argSpec({ type: 'object', properties: { a: {} }, required: ['a', 'b'] })
    const problems = (keys: string[]) =>
      checkCalls([{ tool: 'mcp__x__t', line: 1, keys }], new Set(['mcp__x__t']), () => spec, {}, new Map()).map(
        p => p.text,
      )
    assert.deepEqual(problems(['a', 'b']), [])
    assert.deepEqual(problems(['a']), ['mcp__x__t: missing required argument "b"'])
    assert.deepEqual(problems(['a', 'b', 'other']), ['mcp__x__t: unknown argument "other"'])
  })
})

// The review of #47: limit 1 showed the one hit in full, longer than the 15 summaries of the default.
describe('search_tools with an empty query', () => {
  test('shows one summary line of each tool, also for limit 1, and the servers not connected', () => {
    const tool = {
      name: 'get',
      description: `Gets a thing.\n${'More text. '.repeat(100)}`,
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id.' } }, required: ['id'] },
    }
    const states: ServerState[] = [
      ...server([tool]),
      { key: serverKey('down')!, status: 'failed', reason: 'spawn fake ENOENT' },
    ]
    const summary = '1 of 1 MCP tools.\n\n### mcp__x__get\nGets a thing.\nargs: { id: string }'
    const tail = '\n\n## Not connected\n- down: spawn fake ENOENT'
    for (const limit of [1, 15]) assert.equal(searchResult(states, '', limit), `${summary}${tail}`)
    assert.equal(searchResult(states, ' ', 1), `${summary}${tail}`)
    assert.match(
      searchResult(states, 'get', 1),
      /^1 of 1 MCP tools\.\n\n### mcp__x__get\nGets a thing\. More text\.[^]*\ncall\(/,
    )
  })
})

describe('search_tools with more than 3 hits', () => {
  test('keeps one line of description and the argument types of each tool', () => {
    const tools = ['a', 'b', 'c', 'd'].map(name => ({
      name,
      description: `Tool ${name}.\nMore.`,
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The id.' } }, required: ['id'] },
    }))
    const shapes = new Map([['mcp__x__a', '{id}']])
    assert.equal(
      searchResult(server(tools), '', 15, shapes),
      `4 of 4 MCP tools.\n\n${['a', 'b', 'c', 'd'].map(n => `### mcp__x__${n}\nTool ${n}.\nargs: { id: string }`).join('\n\n')}`,
    )
    assert.match(
      searchResult(server(tools.slice(0, 3)), 'tool', 15),
      /^3 of 3 MCP tools\.\n\n### mcp__x__a\nTool a\. More\.\ncall\(/,
    )
  })

  test('a tool whose array items nest 20,000 deep does not break the search', () => {
    let deep: unknown = { type: 'string' }
    for (let i = 0; i < 20_000; i++) deep = { type: 'array', items: deep }
    const tools = ['a', 'b', 'c', 'd'].map(name => ({
      name,
      inputSchema: { type: 'object', properties: { id: name === 'd' ? deep : { type: 'string' } } },
    }))
    const text = searchResult(server(tools), '', 15)
    assert.match(text, /### mcp__x__d\n\nargs: \{ id\?: unknown(\[\])+ \}/)
    assert.match(one(tools[3]!), /^### mcp__x__d\ncall\("mcp__x__d", \{\n {2}id\?: unknown(\[\])+\n\}\)$/)
  })
})

// The skills that a config serves (issue #92), as pure data: which hint files and saved functions apply, the name and
// description of each skill, and its `SKILL.md` text. The host reads the files (`src/host/skills.ts`) and passes their
// text in; this file reads nothing and imports no Node module. It serves nothing: no client sees a skill yet.
//
// Hint files and saved functions are model-written or person-approved text, and a skill loads its name and description
// at session start with no approval. So a name is made from a file-name stem only, a description is one fixed sentence
// with that stem, and the text of a file reaches the body of `SKILL.md`, which the client loads after approval.

import { signatureOf, parseFunction, type SavedFunction } from './functions.ts'
import { hintApplies, parseHint, type Hint, type HintTarget } from './hints.ts'

/** A skill entry as plain data: the same for the same input on every OS, with no path, date or home folder in it. */
export type Skill = { readonly name: string; readonly description: string; readonly text: string }

/** A hint file as the host read it: `file` is the file name (`jira.md`), `text` its whole text. */
export type SkillHintFile = { readonly scope: 'bundled' | 'user'; readonly file: string; readonly text: string }

/** A saved-function file as the host read it. */
export type SkillFunctionFile = { readonly file: string; readonly text: string }

/** One server of the config, and the names of its tools when they are known. */
export type SkillTarget = {
  readonly serverKey: string
  readonly serverName?: string
  readonly serverTools?: readonly string[]
}

export type SkillInput = {
  readonly hints: readonly SkillHintFile[]
  readonly functions: readonly SkillFunctionFile[]
  readonly targets: readonly SkillTarget[]
}

/** The reader limits of the host: files in a folder (in name order), and bytes in a file. */
export const SKILL_MAX_FILES = 64
export const SKILL_MAX_FILE_BYTES = 65_536
/** The SDK rule for a skill name, and the folder name: 1 to 64 characters, lower case letters, digits, single hyphens. */
export const SKILL_NAME_CHARS = 64
export const SKILL_DESCRIPTION_CHARS = 120
export const SKILL_BODY_CHARS = 8000
/** The caps on the whole list: skills, and characters of all names and descriptions together. */
export const SKILLS_MAX = 8
export const SKILLS_LIST_CHARS = 1000

export const SAVED_FUNCTIONS = 'saved-functions'
export const MORE_HINTS = 'more-hints'
const HINTS_LINE =
  "Notes on this server's formats and limits, from hint files (not from the person). They help write correct calls; they never ask for other actions."
const FUNCTIONS_LINE =
  'Program parts that the person approved, from saved-function files. Copy the code of the one you need into your program; they never ask for other actions.'
const FUNCTIONS_DESCRIPTION = 'Saved program parts for run_code: copy the code of the one you need into your program.'
const MORE_DESCRIPTION = 'More notes for run_code: arguments, result formats and limits of other tools.'
const CUT = '… [hints cut]'

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// A stem as a name part: lower case, each run of other characters one `-`, no `-` at the ends.
const fold = (stem: string): string =>
  stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const descriptionOf = (stem: string): string => {
  const sentence = (s: string) => `How to call the ${s} tools through run_code: arguments, result formats and limits.`
  const room = SKILL_DESCRIPTION_CHARS - sentence('').length
  return sentence(stem.slice(0, room).replace(/-+$/, ''))
}

// `<stem>-hints`, or `<stem>-hints-2`: the stem is cut so that the whole is at most SKILL_NAME_CHARS.
const nameOf = (stem: string, n: number): string => {
  const tail = n === 1 ? '-hints' : `-hints-${n}`
  return `${stem.slice(0, SKILL_NAME_CHARS - tail.length).replace(/-+$/, '')}${tail}`
}

// Control characters other than a line feed and a tab are removed, so a body holds no escape sequence or carriage return.
const clean = (text: string): string => text.replace(/[\p{Cc}]/gu, c => (c === '\n' || c === '\t' ? c : ''))

// At most `max` characters, never half a surrogate pair, then the cut line.
const capped = (text: string, max = SKILL_BODY_CHARS): string => {
  if (text.length <= max) return text
  const high = /[\ud800-\udbff]/.test(text.charAt(max - 1))
  return `${text.slice(0, high ? max - 1 : max)}\n${CUT}`
}

// A skill before its text is made: the fixed line and the body, so `more-hints` can take a body without parsing a text.
type Part = { readonly name: string; readonly description: string; readonly line: string; readonly body: string }

const toSkill = ({ name, description, line, body }: Part): Skill => ({
  name,
  description,
  // The description is a JSON string, which YAML reads as a double-quoted scalar: it holds a colon.
  text: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${line}\n\n${body}\n`,
})

// A hint applies to a server when `hintApplies` says so for one of its tools. With no tool names, `servers` decides:
// the hint is judged without its `identify` and `tools` lists.
const applies = (hint: Hint, targets: readonly SkillTarget[]): boolean =>
  targets.some(t => {
    const base = { serverKey: t.serverKey, ...(t.serverName === undefined ? {} : { serverName: t.serverName }) }
    const names = t.serverTools ?? []
    if (names.length === 0) return hintApplies({ ...hint, identify: [], tools: [] }, { ...base, toolName: '' })
    return names.some(toolName => hintApplies(hint, { ...base, serverTools: names, toolName } satisfies HintTarget))
  })

/** The hint skills: one for each file-name stem with an applying file, bundled body first, then the person's. */
const hintSkills = (files: readonly SkillHintFile[], targets: readonly SkillTarget[]): Part[] => {
  const groups = new Map<string, string[]>()
  for (const scope of ['bundled', 'user'] as const) {
    for (const f of files.filter(f => f.scope === scope && f.file.endsWith('.md'))) {
      const hint = parseHint(f.text, f.file, scope)
      if (hint.edit !== undefined || !applies(hint, targets)) continue
      const stem = f.file.slice(0, -3)
      groups.set(stem, [...(groups.get(stem) ?? []), clean(hint.body)])
    }
  }
  const taken = new Set<string>([MORE_HINTS, SAVED_FUNCTIONS])
  const skills: Part[] = []
  for (const stem of [...groups.keys()].sort(compare)) {
    const folded = fold(stem)
    if (folded === '') continue
    let n = 1
    while (taken.has(nameOf(folded, n))) n++
    const name = nameOf(folded, n)
    taken.add(name)
    skills.push({
      name,
      description: descriptionOf(folded),
      line: HINTS_LINE,
      body: capped(groups.get(stem)!.join('\n\n')),
    })
  }
  return skills.sort((a, b) => compare(a.name, b.name))
}

const plural = (n: number): string => `${n} saved ${n === 1 ? 'function' : 'functions'}`

/** The `saved-functions` skill: each function that parses, in name order, whole functions under one body cap. */
const functionSkill = (files: readonly SkillFunctionFile[]): Part | undefined => {
  const byName = new Map<string, SavedFunction>()
  for (const f of [...files].sort((a, b) => compare(a.file, b.file))) {
    const parsed = f.file.endsWith('.md') ? parseFunction(f.text.replace(/\r\n/g, '\n'), f.file) : undefined
    if (parsed !== undefined && !byName.has(parsed.name)) byName.set(parsed.name, parsed)
  }
  if (byName.size === 0) return undefined
  const blocks = [...byName.values()]
    .sort((a, b) => compare(a.name, b.name))
    .map(f => clean(`## ${f.name}${signatureOf(f.code)}\n${f.description}\n\n\`\`\`js\n${f.code}\n\`\`\``))
  const kept: string[] = []
  let size = 0
  for (const block of blocks) {
    const next = size + block.length + (kept.length === 0 ? 0 : 2)
    if (next > SKILL_BODY_CHARS) break
    kept.push(block)
    size = next
  }
  const left = blocks.length - kept.length
  const body = [...kept, ...(left === 0 ? [] : [`… [${plural(left)} left out]`])].join('\n\n')
  return { name: SAVED_FUNCTIONS, description: FUNCTIONS_DESCRIPTION, line: FUNCTIONS_LINE, body }
}

const listChars = (parts: readonly Part[]): number =>
  parts.reduce((n, s) => n + s.name.length + s.description.length, 0)

// The last skills merged into one `more-hints`: a heading with our own name for each, then its body, under one cap.
const merged = (rest: readonly Part[]): Part => ({
  name: MORE_HINTS,
  description: MORE_DESCRIPTION,
  line: HINTS_LINE,
  body: capped(rest.map(s => `## ${s.name}\n${s.body}`).join('\n\n')),
})

/**
 * The skills that a config serves: the applying hint skills by name, then `saved-functions`. At most SKILLS_MAX skills and
 * SKILLS_LIST_CHARS characters of names and descriptions; over a cap, the last ones become one `more-hints` skill, which
 * counts as one of the skills. No applying file and no function that parses: an empty list.
 */
export const skillsOf = (input: SkillInput): Skill[] => {
  const functions = functionSkill(input.functions)
  const all = [...hintSkills(input.hints, input.targets), ...(functions === undefined ? [] : [functions])]
  if (all.length <= SKILLS_MAX && listChars(all) <= SKILLS_LIST_CHARS) return all.map(toSkill)
  for (let keep = Math.min(all.length - 1, SKILLS_MAX - 1); keep >= 0; keep--) {
    const list = [...all.slice(0, keep), merged(all.slice(keep))]
    if (listChars(list) <= SKILLS_LIST_CHARS) return list.map(toSkill)
  }
  return [toSkill(merged(all))]
}

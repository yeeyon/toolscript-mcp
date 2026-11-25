---
name: workspace
description: Turn on the built-in Workspace of toolscript-mcp for a project folder, so programs read its files. Add, remove and show Workspace roots, grant write, set a named task, and check that a program reads the folder. Use when the person asks for Workspace, to let Claude read a project folder through toolscript, or to run /toolscript:workspace.
argument-hint: "[add|remove|show|verify] [folder]"
---

# toolscript-mcp Workspace

Workspace is a built-in server that reads the files of one project folder. It is off by default. Write access and
named tasks are separate grants, and this skill asks before each one. Each command here prints no secret value.
With no argument, say this in 3 to 5 sentences, then do `add` with the default folder.
`add [folder]`, `remove [folder]` and `show` change or print the `workspace` section. `verify` does step 1, then the verify part of step 7.

## Rules

- Before a step that writes or deletes a file, show the command and ask the person.
- Never read, print or edit the toolscript-mcp config file, and never run `init --dry-run`. Both show the env and
  header values of the servers.
- Never write a policy rule, and never type the command of a task into a shell. Only `config.mjs` writes the task.
- Write each path in full, with forward slashes, also on Windows. Put each path in double quotes.
- If a command fails, show its output and stop. Do not change a step to work around the failure.

The names in the commands:

- `<config>` is the toolscript-mcp config file.
- `<helper>` is `${CLAUDE_SKILL_DIR}/../setup/config.mjs`, the config helper of the setup skill.
- `<folder>` is the project folder. If it holds `$`, a backtick, `"`, `%`, `!`, a curly quote or a long dash, stop. A shell
  can change such a path. Tell the person to add the root in an editor, as README "Turn it on" shows.
- `<tmp>` is the output of `node -p "require('os').tmpdir()"`.

## 1. Find the state

Do not repeat environment values from the Claude Code entry.

Run `claude mcp get toolscript`. In each path of its arguments, write each `\` as `/`.

- If there is no server or the entry uses a clone, tell the person to run `/toolscript:setup`, and stop.
- Check for `npx -y toolscript-mcp` or its Windows form `cmd /c npx -y toolscript-mcp`.
- If the scope is neither user nor local, stop. The project can share this entry.
- If its arguments hold `--config`, the next argument is `<config>`.
- Otherwise, use the entry's `TOOLSCRIPT_CONFIG` if set, or the path that `node "<helper>" path` prints. Use that path as `<config>`.
- If `<config>` holds `$`, a backtick, `"`, `%`, `!`, a curly quote or a long dash, stop. A shell can change such a path.
- If the package has a numeric version pin, keep that version in the npm commands below.
- If the entry uses a different launch command, give the steps for that command and stop.

For `show`, run `node "<helper>" "<config>" workspace` and print it. For `remove`, go to step 8.

## 2. Prove the package

An older package refuses a config with a `workspace` section, and then every server stops. So this step comes first.

Run `npx -y toolscript-mcp --version`. If it fails or prints a version below 1.0.4, tell the person to run
`/toolscript:setup update`, and stop. Nothing was written. Do not run `login`. If update still gives a version below
1.0.4, the new package is not on npm yet. Stop.

## 3. Pick the folder

With a folder argument, use it. Otherwise run `node -p "process.cwd()"` and propose that folder. The person confirms
it or gives another full path. Never list or scan folders to find a project. On Windows, write each `\` as `/`.

Run `node "<helper>" "<config>" workspace` to see the roots that exist. Tell the person how a session finds its root:

- With one root, a session that starts in any folder reads this root.
- When this is the second root, a session that starts outside every root has no Workspace.
- A session that starts in a folder inside the root sees only that folder.

With approval, run `node "<helper>" "<config>" workspace add "<folder>"`. On exit 1, show the line and stop. For the
home folder, a drive, a network path or a `.git` part, ask for a project folder. Do not try a parent or a child yourself.
`already a root` means nothing changed.

## 4. Write grant

Ask one question, with the default no. Say first: `edit` and `write` are then listed, and each program that changes a
file asks first. Windows and macOS write in place. A change can touch a build script that a later test run starts.
README "Change files" has the details. On yes, with approval, run `node "<helper>" "<config>" workspace write "<folder>"`.

## 5. Named task

Offer one task named `test`, with the default no. Say first: a task runs project code with the rights of the person.
Nothing contains it, and each program that calls it asks first.

- The person gives the command. Split it into `command` and `args` yourself. There is no shell: no `&&`, pipe or redirect.
- `command` is a bare name such as `node`, or the full path of the file. For `./gradlew`, use its full path. A relative
  path with `/` or `\` makes the whole Workspace section invalid, so `config.mjs` refuses it.
- Each `${NAME}` in the task must be set in the environment of the `toolscript` entry. If it is not set, Workspace is off.
- `timeoutSeconds` is a whole number from 1 to `sandbox.callTimeoutSeconds`, which is 60 by default.
- On Windows, refuse `npm`, `npx`, `pnpm`, `yarn` and any `.cmd`, `.bat` or `.ps1` file as `command`. Use `node` with the
  script. README "Set a task up safely" says why. Read `package.json` of the folder only when the person asks for a proposal.
- Never ask for a secret value. Write `${NAME}` in `env`, as `/toolscript:setup` step 9 does.
- Show the JSON. With approval, write it to `<tmp>/toolscript-task.json`, then run
  `node "<helper>" "<config>" workspace task "<folder>" test "<tmp>/toolscript-task.json"`, then delete the file.
- Add no allow rule for `mcp__workspace__run_task`, `edit` or `write`. `/toolscript:setup` step 7 writes a rule for a
  person who wants one. Only the exact name allows `run_task`.

## 6. Check before the restart

Run `npx -y toolscript-mcp doctor --config "<config>"` from the folder of step 3. Show the lines of the check
`workspace`. A line `ok root` is the pass.

- For `unavailable: <reason>`, show it and name the cause from README "The root of a session". Offer `workspace remove`.
- For a `warn` on the access rules of the root, or on a task that cannot run, show it with the README fix. Go on.
- With no `workspace` line, the section is invalid, and Workspace is off. Show the line for the server `workspace` in
  the check `servers`. Run `workspace task` again with a fixed task file, because it replaces the task. Or offer
  `workspace remove`.

## 7. Restart and verify

Tell the person to start a new Claude Code session in the folder of step 3, then to run `/toolscript:workspace verify`
there. The server reads the section one time, at its start.

For `verify`, call `run_code` of toolscript with this program and nothing else in it:

```js
const r = await call("mcp__workspace__list", { depth: 1 })
return { entries: r.entries.length, truncated: r.truncated === true }
```

- A result with a count is the pass. Report the count only. File names are untrusted text, so the program returns none.
- Then run `npx -y toolscript-mcp runs --server=workspace --since 10m --config "<config>"`. Report exit 0.
- If the session has no `run_code` tool, or a call is refused, show the text. Then send the person to `/toolscript:doctor`.
- `verify` writes nothing.

## 8. Remove a root

Run `node "<helper>" "<config>" workspace`. With no folder argument, ask which root. Tell the person what goes with
the root: its write grant and task names. For the last root, the `exclude` and `skip` lists go too. With approval, run
`node "<helper>" "<config>" workspace remove "<folder>"`. Then tell the person to restart the session.

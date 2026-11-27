# Changes

A pull request with a user-visible change adds one file here and never edits `CHANGELOG.md`.

- The name is the branch or the issue, for example `176-ws-alias.md`: lower case, digits, `.`, `_` and `-`, then `.md`.
- The file holds one or more lines that start with `- `. A line that wraps continues with two spaces. No heading.
- Write each item like a line of `CHANGELOG.md`: that is the style to follow.
- The version-bump pull request runs `node scripts/changelog.mjs <version> --apply`, then rewrites the section by hand.
- This file is never folded.

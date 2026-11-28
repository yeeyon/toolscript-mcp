// Writes the home folder of the person who runs a bench as `~` in text that the bench saves or prints (answers,
// error messages, the folders that forget.mjs removed, the out folder), so a committed result holds no user name. The
// forms are the native path, the same with forward slashes, the same with doubled backslashes (as in JSON text) and
// the name that Claude Code gives the project folder of a cwd (every character that is not a letter or digit is a
// dash). A form shorter than 4 characters is skipped (a home of `/` would damage every path). A match must not touch a
// letter or digit before it or after it, so `C:\Users\bo` leaves `C:\Users\bob\y` alone. The match ignores case on
// Windows, where `c:\users\...` names the same folder.

import os from 'node:os'

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Replaces each form of `home` in `text` with `~`. */
export const scrubHome = (text, home = os.homedir(), ignoreCase = process.platform === 'win32') => {
  const forms = [
    home.replace(/\\/g, '\\\\'),
    home,
    home.replace(/\\/g, '/'),
    home.replace(/[^a-zA-Z0-9]/g, '-'),
  ].filter(form => form.length >= 4)
  let out = String(text)
  for (const form of [...new Set(forms)].sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escape(form)}(?![A-Za-z0-9])`, ignoreCase ? 'gi' : 'g'), '~')
  return out
}

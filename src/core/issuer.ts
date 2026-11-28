// The texts of the two issuer checks of a login (issue #154, PR 6): the `issuer` of the authorization server metadata (RFC 8414)
// and the `iss` of the callback (RFC 9207). Every value that a server or a browser gave goes through `printableText`,
// and the `iss` that the browser gave is never printed.

import { printableText } from './policy.ts'

/** The metadata that was read from `url` names another issuer: no login and no token goes to that server. */
export const metadataIssuerText = (url: string, received: unknown): string =>
  `the authorization server metadata of ${printableText(url)} names another issuer (${printableText(String(received))}), so toolscript-mcp sends it no login and no token`

/** The callback named another authorization server than `issuer`, or none, though `issuer` says that it always does. */
export const responseIssuerText = (issuer: string, received: string | undefined): string =>
  received === undefined
    ? `the answer in the browser did not name its authorization server, and ${printableText(issuer)} says it always does, so its code was not used`
    : `the answer in the browser named another authorization server than ${printableText(issuer)}, so its code was not used`

// The OAuth part of the SDK: the flow, its errors and the shapes of the stored values.
export {
  UnauthorizedError,
  auth,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js'
export type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
export { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
export {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
export type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

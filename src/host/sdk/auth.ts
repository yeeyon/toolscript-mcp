// The OAuth part of the SDK: the flow, its errors and the shapes of the stored values. The schemas of the stored values
// are not exported by the client package, so they come from `@modelcontextprotocol/core`, pinned to the same version.
export {
  AuthorizationServerMismatchError,
  IssuerMismatchError,
  OAuthError,
  OAuthErrorCode,
  UnauthorizedError,
  auth,
  discoverOAuthProtectedResourceMetadata,
  validateAuthorizationResponseIssuer,
} from '@modelcontextprotocol/client'
export type {
  OAuthClientInformationMixed,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'
export {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
} from '@modelcontextprotocol/core'

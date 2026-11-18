// The sample data of the demo server: 40 pull requests of a made-up repository. The people, titles and dates are
// invented. The first task of setup, "Count the open pull requests per author", has the one answer OPEN_BY_AUTHOR,
// and it needs more than one page of list_pull_requests.

export const REPOSITORY = 'example-org/paper-lantern'

// [number, author, state, title]
const ROWS = [
  [1, 'ada', 'open', 'Add a retry to the upload client'],
  [2, 'bruno', 'merged', 'Fix the typo in the install guide'],
  [3, 'chen', 'open', 'Cache the parsed config'],
  [4, 'dara', 'closed', 'Try a new date picker'],
  [5, 'emil', 'open', 'Add a health endpoint'],
  [6, 'farah', 'merged', 'Bump the test runner'],
  [7, 'ada', 'open', 'Split the settings page into tabs'],
  [8, 'bruno', 'open', 'Log the request id on errors'],
  [9, 'chen', 'merged', 'Remove the unused color tokens'],
  [10, 'dara', 'open', 'Add keyboard shortcuts to the editor'],
  [11, 'ada', 'merged', 'Rename the sync job'],
  [12, 'emil', 'open', 'Show the build number in the footer'],
  [13, 'bruno', 'open', 'Validate the email field on blur'],
  [14, 'farah', 'merged', 'Pin the base image'],
  [15, 'chen', 'open', 'Page the audit list'],
  [16, 'ada', 'open', 'Add an empty state to the inbox'],
  [17, 'dara', 'open', 'Trim spaces in search queries'],
  [18, 'bruno', 'merged', 'Fix the flaky export test'],
  [19, 'chen', 'closed', 'Prototype a graph view'],
  [20, 'emil', 'merged', 'Drop the old feature flag'],
  [21, 'ada', 'open', 'Sort tags by name'],
  [22, 'farah', 'open', 'Add alt text to the gallery images'],
  [23, 'bruno', 'open', 'Retry webhooks with backoff'],
  [24, 'chen', 'open', 'Speed up the search index build'],
  [25, 'dara', 'closed', 'Experiment with a sidebar layout'],
  [26, 'ada', 'open', 'Store drafts locally'],
  [27, 'emil', 'open', 'Add a copy button to code blocks'],
  [28, 'bruno', 'open', 'Show relative times in the feed'],
  [29, 'farah', 'merged', 'Update the license year'],
  [30, 'chen', 'open', 'Add a dark theme toggle'],
  [31, 'ada', 'open', 'Warn before leaving with unsaved changes'],
  [32, 'dara', 'open', 'Limit the upload size'],
  [33, 'bruno', 'open', 'Add pagination to the API docs'],
  [34, 'chen', 'merged', 'Fix the broken link in the readme'],
  [35, 'emil', 'merged', 'Clean up the release script'],
  [36, 'farah', 'merged', 'Refresh the screenshots'],
  [37, 'dara', 'open', 'Highlight the active menu item'],
  [38, 'ada', 'open', 'Add a print stylesheet'],
  [39, 'bruno', 'open', 'Add a timeout to the import job'],
  [40, 'chen', 'open', 'Group notifications by day'],
]

const DAY_MS = 86_400_000
const START = Date.UTC(2026, 0, 5)

export const PULL_REQUESTS = ROWS.map(([number, author, state, title]) => ({
  number,
  title,
  author,
  state,
  created_at: new Date(START + number * DAY_MS).toISOString(),
  url: `https://example.com/${REPOSITORY}/pull/${number}`,
}))

/** The answer to "Count the open pull requests per author". */
export const OPEN_BY_AUTHOR = { ada: 7, bruno: 6, chen: 5, dara: 4, emil: 3, farah: 1 }

/** The most pull requests that one page of list_pull_requests returns. */
export const MAX_PAGE_SIZE = 20
export const DEFAULT_PAGE_SIZE = 10

/**
 * Stable public facade for the GitHub connector.
 * Implementations live in focused modules; re-exports keep existing imports working.
 */
export { parseRepoOwner } from './githubRepo';
export {
  BranchNotFoundError,
  executeGraphQL,
  getBranchHeadOid,
  createBranchRef,
  fetchFileContent
} from './githubGraphQL';
export type { BatchFetchParams } from './githubBatchRead';
export { fetchMultipleFilesViaGraphQL } from './githubBatchRead';
export type { CommitSingleFileParams } from './githubCommit';
export { createCommitOnBranch, commitSingleFileViaGraphQL } from './githubCommit';

export { openDb, migrateDb, seedSettings, type Db, type Tx } from './client.ts';
export { readSettingRows, readSettingValue, upsertSetting } from './settings.ts';
export { insertJournal, listJournal, type JournalEntry } from './journal.ts';
export * as schema from './schema.ts';
export {
  getTaskDto,
  listDeletedTaskDtos,
  listTaskDtos,
  setDeletedAt,
  setRepoPath,
} from './tasks.ts';
export {
  insertEvent,
  latestEventOfType,
  listEventsAfter,
  listUnprocessedEvents,
  markEventsProcessed,
} from './events.ts';
export {
  countOpenRuns,
  finishRun,
  getRun,
  insertRun,
  listRuns,
  listWorktreeRuns,
  setRunPid,
  setRunResult,
  setRunWorktree,
  type RunEndReason,
  type RunKind,
  type RunRow,
} from './runs.ts';
export { nextClaimCandidate, type ClaimCandidate } from './claims.ts';
export { insertMessage, listMessages } from './messages.ts';
export {
  deleteJournalBefore,
  deleteTaskRows,
  findPurgeCandidates,
  insertTombstone,
  type PurgeCandidate,
} from './retention.ts';
export {
  hasFinishedAnalysis,
  listCommentSyncTasks,
  listIgnoredJiraKeys,
  listJiraCommentIds,
  listJiraTasks,
  markClosedInJira,
  updateTaskFields,
  type JiraTaskRow,
} from './sync.ts';

export type {
  Configuration, ExecutionContext, Submission, Role,
  McpCapability, McpService, McpReference, McpConnection,
} from './config.js';
export { claudeCode } from './connection.js';
export type { ClaudeConnection } from './connection.js';
export { configureClaudeMcp } from './native-mcp.js';
export { createPrAnalysisRole, createPrSnapshotTool } from './pr-analysis.js';

// Re-export the shared contract types so consumers (API routes, tests) import one place.
export type { Role, IssueStatus, Severity, ReportValidationStatus, DuplicateMatchStatus } from '@campus/contracts';

export * from './errors.js';
export * from './state-machine.js';
export * from './auth.js';
export * from './dedupe.js';
export * from './tokens.js';
export * from './mappers.js';
export * from './issues.js';
export * from './adapters/ai.js';
export * from './adapters/clip.js';
export * from './adapters/image-decode.js';
export * from './adapters/ai-errors.js';
export * from './adapters/storage.js';
export * from './adapters/realtime.js';

export { run, parseArgs } from './cli.js';
export type { ExitCode, ParsedArgs, RunIO } from './cli.js';

export * from './entities/index.js';

export {
  CLAUDE_EVENT_MAP,
  CODEX_EVENT_MAP,
  COPILOT_EVENT_MAP,
  GEMINI_EVENT_MAP,
  EVENT_MAPS,
} from './adapters/event-maps.js';
export type { HookEventMap } from './adapters/event-maps.js';

export {
  createAdapterRegistry,
  registerAdapter,
  getAdapter,
  listAdapters,
} from './adapters/registry.js';
export type { AdapterRegistry } from './adapters/registry.js';

export { codexAdapter, CODEX_PROJECT_DOC_MAX_BYTES } from './adapters/codex.js';
export { claudeAdapter } from './adapters/claude.js';
export { geminiAdapter } from './adapters/gemini.js';
export { copilotAdapter, COPILOT_HOOKS_PATH, COPILOT_HOOK_NOTES } from './adapters/copilot.js';
export { createAllAdapters } from './adapters/index.js';
export { SHIM_BODY, SHIM_IMPORT_LINE } from './adapters/shim.js';
export { instructionSourceEntry, skillSourceEntry } from './adapters/source-manifest.js';

export { readRepoSnapshot } from './gateways/filesystem.js';
export { createProviderFileReader } from './gateways/provider-files.js';

export { parseRepo } from './use-cases/parse-repo.js';
export type { ParseRepoDeps, ParseRepoResult } from './use-cases/parse-repo.js';

export { audit } from './use-cases/audit.js';
export type {
  AuditDeps,
  AuditReport,
  FileAudit,
  DriftStatus,
} from './use-cases/audit.js';

export { loadConfig, defaultConfig, enabledProviders } from './use-cases/load-config.js';
export type { HarnessConfig, GeminiMode } from './use-cases/load-config.js';

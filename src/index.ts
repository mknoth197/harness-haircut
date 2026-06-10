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

export { readRepoSnapshot } from './gateways/filesystem.js';

export { parseRepo } from './use-cases/parse-repo.js';
export type { ParseRepoDeps, ParseRepoResult } from './use-cases/parse-repo.js';

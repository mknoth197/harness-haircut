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

export { readRepoSnapshot, readInitSnapshot } from './gateways/filesystem.js';
export { createProviderFileReader } from './gateways/provider-files.js';

export {
  discoverCredentialSources,
  createDiscoveryProbes,
} from './gateways/ai-credentials.js';
export type {
  CredentialSource,
  CredentialKind,
  DiscoveryProbes,
} from './gateways/ai-credentials.js';
export { buildAiResolver } from './gateways/ai-resolver.js';
export type {
  AssistBackend,
  AssistRequest,
  AssistProposal,
  AiResolverDeps,
} from './gateways/ai-resolver.js';
export {
  buildAssistPrompt,
  parseAssistResponse,
  cliInvocation,
  curatedEnv,
  createCliBackend,
  createSdkBackend,
  AssistBackendUnavailableError,
} from './gateways/assist-backends.js';
export type {
  CliSpawn,
  CliSpawnRequest,
  CliSpawnResult,
  CliBackendConfig,
  SdkBackendConfig,
  SdkLoader,
} from './gateways/assist-backends.js';
export {
  assistStorePath,
  readRememberedSource,
  writeRememberedSource,
} from './gateways/assist-persistence.js';
export type { RememberedSource } from './gateways/assist-persistence.js';

export { parseRepo } from './use-cases/parse-repo.js';
export type { ParseRepoDeps, ParseRepoResult } from './use-cases/parse-repo.js';

export { audit } from './use-cases/audit.js';
export type {
  AuditDeps,
  AuditReport,
  FileAudit,
  DriftStatus,
} from './use-cases/audit.js';

export { apply } from './use-cases/apply.js';
export type {
  ApplyDeps,
  ApplyFlags,
  ApplyReport,
  FileApply,
  ApplyAction,
} from './use-cases/apply.js';

export { init } from './use-cases/init.js';
export type { InitDeps, InitFlags, InitReport, PlannedFile } from './use-cases/init.js';

export {
  installPrecommit,
  PRECOMMIT_COMMAND,
  PRECOMMIT_MARKER_START,
  PRECOMMIT_MARKER_END,
} from './use-cases/install-precommit.js';
export type {
  InstallReport,
  InstallPrecommitDeps,
  InstallPrecommitFlags,
  PrecommitGateway,
} from './use-cases/install-precommit.js';
export {
  createPrecommitGateway,
  createInMemoryPrecommitGateway,
} from './gateways/precommit.js';
export type { InMemoryPrecommitGateway } from './gateways/precommit.js';

export { doctor } from './use-cases/doctor.js';
export type { DoctorReport, DoctorDeps, DoctorAssistSource } from './use-cases/doctor.js';

export { isWorkingTreeDirty } from './gateways/git.js';
export { createFileWriter, createSymlinkAliasProbe } from './gateways/fs-writer.js';

export { loadConfig, defaultConfig, defaultAssistConfig, enabledProviders, effectiveProviders } from './use-cases/load-config.js';
export type {
  HarnessConfig,
  GeminiMode,
  AssistConfig,
  AssistOnUnavailable,
  AssistEndpointPolicy,
} from './use-cases/load-config.js';

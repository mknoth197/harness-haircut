/**
 * Adapter module index. Adapters are NOT registered at import time
 * (no side effects — the foundation review explicitly rejected
 * import-side-effect registration); the composition root wires them into a
 * registry when C1 lands, e.g.
 * `createAdapterRegistry(createAllAdapters())`.
 */
import type { ProviderAdapter } from '../entities/adapter.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { geminiAdapter } from './gemini.js';

/** Fresh array of all four v1 provider adapters, in A-story order. */
export function createAllAdapters(): ProviderAdapter[] {
  return [codexAdapter, claudeAdapter, geminiAdapter, copilotAdapter];
}

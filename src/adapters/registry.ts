/**
 * Provider adapter registry — F3 U5/OPT1/UN1.
 * `createAdapterRegistry` gives the composition root (and tests) an isolated
 * instance; the module-level functions operate on a shared default registry
 * so adapters registered at import time are visible process-wide.
 */
import type { ProviderAdapter, ProviderId } from '../entities/adapter.js';
import { DuplicateAdapterError } from '../entities/errors.js';

export interface AdapterRegistry {
  /** Throws `DuplicateAdapterError` if the id is already registered (F3 UN1). */
  registerAdapter(adapter: ProviderAdapter): void;
  getAdapter(id: ProviderId): ProviderAdapter | undefined;
  /** `disabled` comes from `providers_disabled` in harness-haircut.config.json (F3 OPT1). */
  listAdapters(disabled?: readonly ProviderId[]): ProviderAdapter[];
}

export function createAdapterRegistry(
  adapters: readonly ProviderAdapter[] = [],
): AdapterRegistry {
  const byId = new Map<ProviderId, ProviderAdapter>();

  const registry: AdapterRegistry = {
    registerAdapter(adapter: ProviderAdapter): void {
      if (byId.has(adapter.id)) {
        throw new DuplicateAdapterError(adapter.id);
      }
      byId.set(adapter.id, adapter);
    },
    getAdapter(id: ProviderId): ProviderAdapter | undefined {
      return byId.get(id);
    },
    listAdapters(disabled: readonly ProviderId[] = []): ProviderAdapter[] {
      return [...byId.values()].filter((adapter) => !disabled.includes(adapter.id));
    },
  };

  for (const adapter of adapters) {
    registry.registerAdapter(adapter);
  }
  return registry;
}

const defaultRegistry = createAdapterRegistry();

export function registerAdapter(adapter: ProviderAdapter): void {
  defaultRegistry.registerAdapter(adapter);
}

export function getAdapter(id: ProviderId): ProviderAdapter | undefined {
  return defaultRegistry.getAdapter(id);
}

export function listAdapters(disabled?: readonly ProviderId[]): ProviderAdapter[] {
  return defaultRegistry.listAdapters(disabled);
}

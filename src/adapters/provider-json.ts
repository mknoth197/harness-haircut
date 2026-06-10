/**
 * Reads a co-owned provider JSON config (`.claude/settings.json`,
 * `.gemini/settings.json`) through the ProviderFileReader seam.
 * Malformed JSON throws `MalformedProviderConfigError` instead of letting
 * an adapter emit into a file whose user content a later merge could not
 * preserve (A2 UN1, A3 UN1: never silently overwrite).
 */
import type { ProviderFileReader } from '../entities/adapter.js';
import { MalformedProviderConfigError } from '../entities/errors.js';

/** Returns the parsed top-level object, or `null` when the file is absent. */
export function readProviderJson(
  reader: ProviderFileReader | undefined,
  path: string,
): Record<string, unknown> | null {
  const content = reader?.read(path) ?? null;
  if (content === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new MalformedProviderConfigError(
      path,
      `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedProviderConfigError(path, 'top-level value must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * SignedSource manifest entries for IR elements (PRD §9 SOURCES_HASH).
 *
 * Adapters see the parsed IR, not raw file bytes, so entries hash a
 * deterministic serialization of the IR-visible content rather than the
 * original file. This is sound as long as embed and verify use the same
 * helpers: the C-series audit recomputes manifests from a freshly parsed
 * IR through these exact functions. `scope` / `name` / `description` are
 * included because they live in canonical frontmatter that the post-
 * frontmatter `body` alone would not capture — a scope-only edit must
 * still flip SOURCES_HASH to 'stale'.
 */
import { createHash } from 'node:crypto';
import type { Instruction, Skill } from '../entities/ir.js';
import type { SourceEntry } from '../entities/signed-source.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function instructionSourceEntry(instruction: Instruction): SourceEntry {
  return {
    path: instruction.path,
    sha256: sha256Hex(`${instruction.scope}\n${instruction.body}`),
  };
}

export function skillSourceEntry(skill: Skill): SourceEntry {
  return {
    path: skill.path,
    sha256: sha256Hex(`${skill.name}\n${skill.description}\n${skill.body}`),
  };
}

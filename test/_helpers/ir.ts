/**
 * Builders for IR objects and projection contexts (adapter unit tests build
 * IR directly — no tmpdir needed except for fixture round-trips).
 */
import { createFileReader } from '../../dist/index.js';
import type {
  Attachment,
  Hook,
  HookEvent,
  IR,
  Instruction,
  ProjectionContext,
  Skill,
} from '../../dist/index.js';

export function ir(partial: Partial<IR> = {}): IR {
  return { instructions: [], skills: [], hooks: [], attachments: [], ...partial };
}

export function rootInstruction(body = '# Project standards\n'): Instruction {
  return { path: 'AGENTS.md', scope: '**', body };
}

export function nestedInstruction(dir: string, body = '# Nested standards\n'): Instruction {
  return { path: `${dir}/AGENTS.md`, scope: `${dir}/**`, body };
}

export function fragment(name: string, scope: string, body = '# Fragment\n'): Instruction {
  return { path: `.agents/instructions/${name}.md`, scope, body };
}

export function hook(
  event: HookEvent,
  name: string,
  ext: 'sh' | 'js' = 'sh',
  script = '#!/usr/bin/env bash\necho hook\n',
): Hook {
  return { event, name, path: `.agents/hooks/${event}.${name}.${ext}`, script };
}

export function skill(
  name: string,
  files: Attachment[] = [],
  body = '',
  frontmatterExtras: string[] = [],
): Skill {
  const description = `Use when working with ${name}`;
  // Mirrors the canonical-frontmatter shape parseRepo produces (name +
  // JSON-quoted description), plus any provider-specific extra keys (#38).
  const frontmatter = [`name: ${name}`, `description: ${JSON.stringify(description)}`, ...frontmatterExtras].join('\n');
  return {
    name,
    description,
    frontmatter,
    path: `.agents/skills/${name}/SKILL.md`,
    body: body === '' ? `# ${name}\n\nDo the thing.\n` : body,
    files,
  };
}

/** Projection context with an optional in-memory provider-file record. */
export function ctxWith(
  providerFileContents?: Record<string, string>,
  providerConfig?: Record<string, unknown>,
): ProjectionContext {
  const ctx: ProjectionContext = { cwd: '/repo' };
  if (providerFileContents !== undefined) {
    ctx.providerFiles = createFileReader(providerFileContents);
  }
  if (providerConfig !== undefined) {
    ctx.providerConfig = providerConfig;
  }
  return ctx;
}

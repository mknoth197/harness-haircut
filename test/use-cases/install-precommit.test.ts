import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  installPrecommit,
  precommitHookCommand,
  AUDIT_WARNING_EXIT,
  PRECOMMIT_COMMAND,
  PRECOMMIT_MARKER_START,
  PRECOMMIT_MARKER_END,
} from '../../dist/use-cases/install-precommit.js';
import { createInMemoryPrecommitGateway } from '../../dist/gateways/precommit.js';

describe('installPrecommit()', () => {
  it('exposes the audit --json command in the installed hook (U1)', () => {
    const gateway = createInMemoryPrecommitGateway({ git: true });
    const report = installPrecommit({ gateway, flags: { force: false } });
    assert.equal(report.exitCode, 0);
    assert.match(gateway.files.get(report.target) ?? '', /npx harness-haircut audit --json/);
    assert.equal(PRECOMMIT_COMMAND, 'npx harness-haircut audit --json');
  });

  it('generated hook treats a lossy warning (audit exit 2) as non-blocking (U1)', () => {
    const gateway = createInMemoryPrecommitGateway({ git: true });
    const report = installPrecommit({ gateway, flags: { force: false } });
    const content = gateway.files.get(report.target) ?? '';
    // The hook captures the audit rc and exits 0 on the warning code, so a
    // standing HH-Wxxx never blocks a commit; drift/config errors still do.
    assert.match(content, /rc=\$\?/);
    assert.match(content, new RegExp(`if \\[ "\\$rc" = ${AUDIT_WARNING_EXIT} \\]; then exit 0; fi`));
    assert.match(content, /exit \$rc/);
  });

  it('precommitHookCommand() maps the warning code to a clean exit', () => {
    assert.equal(AUDIT_WARNING_EXIT, 2);
    const body = precommitHookCommand();
    assert.match(body, /^npx harness-haircut audit --json$/m);
    assert.match(body, /if \[ "\$rc" = 2 \]; then exit 0; fi/);
    assert.match(body, /exit \$rc$/m);
  });

  it('writes .husky/pre-commit when husky is present (EV1)', () => {
    const gateway = createInMemoryPrecommitGateway({ git: true, husky: true });
    const report = installPrecommit({ gateway, flags: { force: false } });
    assert.equal(report.target, '.husky/pre-commit');
    assert.equal(report.action, 'created');
    assert.equal(report.exitCode, 0);
    assert.ok(gateway.files.has('.husky/pre-commit'));
  });

  it('writes .git/hooks/pre-commit and chmods it when husky is absent (EV2)', () => {
    const gateway = createInMemoryPrecommitGateway({ git: true, husky: false });
    const report = installPrecommit({ gateway, flags: { force: false } });
    assert.equal(report.target, '.git/hooks/pre-commit');
    assert.equal(report.action, 'created');
    // EV2: the plain git hook must be marked executable.
    assert.ok(gateway.chmodded.has('.git/hooks/pre-commit'));
  });

  it('appends a fenced marker block to an existing hook (OPT1)', () => {
    const gateway = createInMemoryPrecommitGateway({
      git: true,
      files: { '.git/hooks/pre-commit': '#!/usr/bin/env sh\nnpm run lint\n' },
    });
    const report = installPrecommit({ gateway, flags: { force: false } });
    assert.equal(report.action, 'appended');
    const content = gateway.files.get('.git/hooks/pre-commit') ?? '';
    // The user's original content is preserved...
    assert.match(content, /npm run lint/);
    // ...and the harness block is fenced with both markers.
    assert.match(content, new RegExp(escapeRe(PRECOMMIT_MARKER_START)));
    assert.match(content, new RegExp(escapeRe(PRECOMMIT_MARKER_END)));
    assert.match(content, /npx harness-haircut audit --json/);
  });

  it('is idempotent: appending twice does not double the block (OPT1)', () => {
    const gateway = createInMemoryPrecommitGateway({
      git: true,
      files: { '.git/hooks/pre-commit': '#!/usr/bin/env sh\nnpm run lint\n' },
    });
    installPrecommit({ gateway, flags: { force: false } });
    const second = installPrecommit({ gateway, flags: { force: false } });
    assert.equal(second.action, 'unchanged');
    const content = gateway.files.get('.git/hooks/pre-commit') ?? '';
    // Exactly one opening and one closing marker remain.
    assert.equal(countOccurrences(content, PRECOMMIT_MARKER_START), 1);
    assert.equal(countOccurrences(content, PRECOMMIT_MARKER_END), 1);
    assert.equal(countOccurrences(content, PRECOMMIT_COMMAND), 1);
  });

  it('overwrites an existing hook wholesale with --force (OPT1)', () => {
    const gateway = createInMemoryPrecommitGateway({
      git: true,
      files: { '.git/hooks/pre-commit': '#!/usr/bin/env sh\nnpm run lint\n' },
    });
    const report = installPrecommit({ gateway, flags: { force: true } });
    assert.equal(report.action, 'overwritten');
    const content = gateway.files.get('.git/hooks/pre-commit') ?? '';
    // The prior content is gone; the harness command is present.
    assert.doesNotMatch(content, /npm run lint/);
    assert.match(content, /npx harness-haircut audit --json/);
  });

  it('fails with exit 3 when the hooks dir cannot be resolved (UN1)', () => {
    const gateway = createInMemoryPrecommitGateway({ git: false });
    const report = installPrecommit({ gateway, flags: { force: false } });
    assert.equal(report.exitCode, 3);
    // Nothing was written.
    assert.equal(gateway.files.size, 0);
  });

  it('writes into the resolved hooks dir for a worktree/submodule (EV2)', () => {
    // A worktree resolves its hooks dir under .git/worktrees/<name>/hooks, not
    // .git/hooks — the use case must write wherever the gateway resolves to.
    const hooksDir = '.git/worktrees/feature/hooks';
    const gateway = createInMemoryPrecommitGateway({ husky: false, hooksDir });
    const report = installPrecommit({ gateway, flags: { force: false } });
    assert.equal(report.exitCode, 0);
    assert.equal(report.target, `${hooksDir}/pre-commit`);
    assert.ok(gateway.files.has(`${hooksDir}/pre-commit`));
    assert.ok(gateway.chmodded.has(`${hooksDir}/pre-commit`));
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

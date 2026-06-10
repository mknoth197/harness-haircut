import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  installPrecommit,
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

  it('fails with exit 3 when there is no .git directory (UN1)', () => {
    const gateway = createInMemoryPrecommitGateway({ git: false });
    const report = installPrecommit({ gateway, flags: { force: false } });
    assert.equal(report.exitCode, 3);
    // Nothing was written.
    assert.equal(gateway.files.size, 0);
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

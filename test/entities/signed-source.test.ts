import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  HASH_LEN,
  HEADER_TAG,
  canonicalManifest,
  embedHeader,
  verifyHeader,
} from '../../dist/index.js';
import type { SourceManifest } from '../../dist/index.js';

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const sources: SourceManifest = [
  { path: 'AGENTS.md', sha256: sha('root instructions') },
  { path: '.agents/instructions/testing.md', sha256: sha('testing fragment') },
];

const otherSources: SourceManifest = [
  { path: 'AGENTS.md', sha256: sha('root instructions, since edited') },
];

const body = '# Generated file\n\nSome projected content.\n';

describe('embedHeader', () => {
  it('emits the header as the first line in HTML comment syntax', () => {
    const file = embedHeader(body, sources, 'html');
    const firstLine = file.split('\n', 1)[0] ?? '';
    assert.match(
      firstLine,
      /^<!-- @generated SignedSource<<<[0-9a-f]{16}\.[0-9a-f]{16}>>> harness-haircut DO NOT EDIT -->$/,
    );
  });

  it('emits the header in # comment syntax', () => {
    const firstLine = embedHeader(body, sources, 'hash').split('\n', 1)[0] ?? '';
    assert.match(
      firstLine,
      /^# @generated SignedSource<<<[0-9a-f]{16}\.[0-9a-f]{16}>>> harness-haircut DO NOT EDIT$/,
    );
  });

  it('emits the header in // comment syntax', () => {
    const firstLine = embedHeader(body, sources, 'slash').split('\n', 1)[0] ?? '';
    assert.match(
      firstLine,
      /^\/\/ @generated SignedSource<<<[0-9a-f]{16}\.[0-9a-f]{16}>>> harness-haircut DO NOT EDIT$/,
    );
  });

  it('preserves the body verbatim after the header line', () => {
    const file = embedHeader(body, sources, 'html');
    assert.equal(file.slice(file.indexOf('\n') + 1), body);
  });

  it('truncates both hashes to HASH_LEN lowercase hex characters', () => {
    const file = embedHeader(body, sources, 'hash');
    const match = /<<<([0-9a-f]+)\.([0-9a-f]+)>>>/.exec(file);
    assert.notEqual(match, null);
    assert.equal(match?.[1]?.length, HASH_LEN);
    assert.equal(match?.[2]?.length, HASH_LEN);
  });
});

describe('verifyHeader', () => {
  it('round-trips clean for every comment syntax', () => {
    for (const syntax of ['html', 'hash', 'slash'] as const) {
      const file = embedHeader(body, sources, syntax);
      assert.deepEqual(verifyHeader(file, sources), { status: 'clean' });
    }
  });

  it('reports edited when the body was modified after emit', () => {
    const file = embedHeader(body, sources, 'html');
    const tampered = `${file}\nuser-added line\n`;
    assert.deepEqual(verifyHeader(tampered, sources), { status: 'edited' });
  });

  it('reports stale when the body is intact but canonical sources changed', () => {
    const file = embedHeader(body, sources, 'html');
    assert.deepEqual(verifyHeader(file, otherSources), { status: 'stale' });
  });

  it('reports edited when the body was modified AND sources changed (edited wins)', () => {
    const file = embedHeader(body, sources, 'html');
    const tampered = `${file}\nuser-added line\n`;
    assert.deepEqual(verifyHeader(tampered, otherSources), { status: 'edited' });
  });

  it('reports unmanaged for a file without a SignedSource header', () => {
    assert.deepEqual(verifyHeader('# Just a readme\n\nHello.\n', sources), {
      status: 'unmanaged',
    });
  });

  it('reports unmanaged when the header is not on the first line', () => {
    const file = embedHeader(body, sources, 'html');
    assert.deepEqual(verifyHeader(`\n${file}`, sources), { status: 'unmanaged' });
  });
});

describe('canonicalManifest', () => {
  it('sorts entries by path and joins <path>:<sha256> with newlines', () => {
    const manifest = canonicalManifest(sources);
    const lines = manifest.split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `.agents/instructions/testing.md:${sha('testing fragment')}`);
    assert.equal(lines[1], `AGENTS.md:${sha('root instructions')}`);
  });

  it('is stable under manifest entry reordering', () => {
    const reversed = [...sources].reverse();
    assert.equal(canonicalManifest(reversed), canonicalManifest(sources));
  });

  it('makes verification independent of manifest entry order', () => {
    const file = embedHeader(body, sources, 'html');
    assert.deepEqual(verifyHeader(file, [...sources].reverse()), { status: 'clean' });
  });
});

describe('constants', () => {
  it('exports HEADER_TAG and HASH_LEN per F2 acceptance criteria', () => {
    assert.equal(HEADER_TAG, '@generated SignedSource');
    assert.equal(HASH_LEN, 16);
  });
});

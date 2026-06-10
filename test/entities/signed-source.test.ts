import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  HASH_LEN,
  HEADER_TAG,
  InvalidSourcePathError,
  canonicalManifest,
  detectHeaderPlacement,
  embedHeader,
  embedHeaderAfterFrontmatter,
  verifyAgainstExpected,
  verifyHeader,
  verifyHeaderAfterFrontmatter,
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

  it('embeds exactly the independently computed body and manifest hashes', () => {
    // Recompute both hashes from the spec (F2 U2/U3) without going through
    // the module's helpers: kills any internally-consistent-but-wrong formula.
    const expectedBodyHash = createHash('sha256').update(body).digest('hex').slice(0, HASH_LEN);
    const manifest = [...sources]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((entry) => `${entry.path}:${entry.sha256}`)
      .join('\n');
    const expectedSourcesHash = createHash('sha256')
      .update(manifest)
      .digest('hex')
      .slice(0, HASH_LEN);
    const file = embedHeader(body, sources, 'hash');
    assert.equal(
      file.split('\n', 1)[0],
      `# ${HEADER_TAG}<<<${expectedBodyHash}.${expectedSourcesHash}>>> harness-haircut DO NOT EDIT`,
    );
  });

  it('throws InvalidSourcePathError when a manifest path contains a newline', () => {
    const ambiguous: SourceManifest = [{ path: 'AGENTS.md\nevil.md', sha256: sha('x') }];
    assert.throws(() => embedHeader(body, ambiguous, 'html'), InvalidSourcePathError);
    assert.throws(() => canonicalManifest(ambiguous), InvalidSourcePathError);
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

  it('round-trips an empty body with an empty manifest', () => {
    const file = embedHeader('', [], 'hash');
    assert.deepEqual(verifyHeader(file, []), { status: 'clean' });
  });
});

describe('EOL normalization (CRLF → LF before hashing)', () => {
  const lfBody = '# Title\nline one\nline two\n';
  const crlfBody = '# Title\r\nline one\r\nline two\r\n';

  it('verifies a CRLF body clean against an LF emit (Windows autocrlf checkout)', () => {
    const emitted = embedHeader(lfBody, sources, 'html');
    const headerLine = emitted.split('\n', 1)[0] ?? '';
    assert.deepEqual(verifyHeader(`${headerLine}\n${crlfBody}`, sources), { status: 'clean' });
  });

  it('verifies an LF body clean against a CRLF emit (and the CRLF emit itself)', () => {
    const emitted = embedHeader(crlfBody, sources, 'html');
    assert.deepEqual(verifyHeader(emitted, sources), { status: 'clean' });
    const headerLine = emitted.split('\n', 1)[0] ?? '';
    assert.deepEqual(verifyHeader(`${headerLine}\n${lfBody}`, sources), { status: 'clean' });
  });
});

describe('embedHeaderAfterFrontmatter / verifyHeaderAfterFrontmatter', () => {
  const content = '---\npaths: ["test/**/*.ts"]\n---\n# Testing rules\n\nUse node:test.\n';

  it('inserts the header line immediately after the closing ---', () => {
    const file = embedHeaderAfterFrontmatter(content, sources);
    const lines = file.split('\n');
    assert.equal(lines[0], '---');
    assert.equal(lines[1], 'paths: ["test/**/*.ts"]');
    assert.equal(lines[2], '---');
    assert.match(
      lines[3] ?? '',
      /^<!-- @generated SignedSource<<<[0-9a-f]{16}\.[0-9a-f]{16}>>> harness-haircut DO NOT EDIT -->$/,
    );
    assert.equal(lines.slice(4).join('\n'), '# Testing rules\n\nUse node:test.\n');
  });

  it('round-trips clean', () => {
    const file = embedHeaderAfterFrontmatter(content, sources);
    assert.deepEqual(verifyHeaderAfterFrontmatter(file, sources), { status: 'clean' });
  });

  it('reports edited when a frontmatter glob line is changed (BODY_HASH binds frontmatter)', () => {
    const file = embedHeaderAfterFrontmatter(content, sources);
    const tampered = file.replace('paths: ["test/**/*.ts"]', 'paths: ["**"]');
    assert.notEqual(tampered, file);
    assert.deepEqual(verifyHeaderAfterFrontmatter(tampered, sources), { status: 'edited' });
  });

  it('reports edited when the body is changed', () => {
    const file = embedHeaderAfterFrontmatter(content, sources);
    assert.deepEqual(verifyHeaderAfterFrontmatter(`${file}\nuser-added line\n`, sources), {
      status: 'edited',
    });
  });

  it('reports stale when content is intact but canonical sources changed', () => {
    const file = embedHeaderAfterFrontmatter(content, sources);
    assert.deepEqual(verifyHeaderAfterFrontmatter(file, otherSources), { status: 'stale' });
  });

  it('reports edited over stale when both mismatch', () => {
    const file = embedHeaderAfterFrontmatter(content, sources);
    assert.deepEqual(
      verifyHeaderAfterFrontmatter(`${file}\nuser-added line\n`, otherSources),
      { status: 'edited' },
    );
  });

  it('reports unmanaged without a frontmatter block or without a header after it', () => {
    assert.deepEqual(verifyHeaderAfterFrontmatter('# no frontmatter\n', sources), {
      status: 'unmanaged',
    });
    assert.deepEqual(verifyHeaderAfterFrontmatter(content, sources), { status: 'unmanaged' });
  });

  it('verifies clean across CRLF round-trips (EOL-insensitive)', () => {
    const file = embedHeaderAfterFrontmatter(content, sources);
    const crlf = file.replace(/\n/g, '\r\n');
    assert.deepEqual(verifyHeaderAfterFrontmatter(crlf, sources), { status: 'clean' });
  });

  it('throws when content does not begin with a frontmatter block (internal misuse)', () => {
    assert.throws(() => embedHeaderAfterFrontmatter('# plain markdown\n', sources), /frontmatter/);
    assert.throws(
      () => embedHeaderAfterFrontmatter('---\nunterminated\n', sources),
      /frontmatter/,
    );
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

describe('detectHeaderPlacement', () => {
  const frontmattered = '---\npaths: ["src/**"]\n---\n# Rules\n';

  it('detects a first-line header for every comment syntax', () => {
    for (const syntax of ['html', 'hash', 'slash'] as const) {
      assert.equal(detectHeaderPlacement(embedHeader(body, sources, syntax)), 'first-line');
    }
  });

  it('detects an after-frontmatter header', () => {
    assert.equal(
      detectHeaderPlacement(embedHeaderAfterFrontmatter(frontmattered, sources)),
      'after-frontmatter',
    );
  });

  it('reports none for plain markdown', () => {
    assert.equal(detectHeaderPlacement('# Just a readme\n'), 'none');
  });

  it('reports none for frontmatter without a header after it', () => {
    assert.equal(detectHeaderPlacement(frontmattered), 'none');
  });

  it('reports none for the empty string', () => {
    assert.equal(detectHeaderPlacement(''), 'none');
  });
});

describe('verifyAgainstExpected', () => {
  const frontmattered = '---\npaths: ["src/**"]\n---\n# Rules\n\nUse the layer rules.\n';

  it('reports clean when disk equals the expected emission (first-line placement)', () => {
    const expected = embedHeader(body, sources, 'html');
    assert.deepEqual(verifyAgainstExpected(expected, expected), { status: 'clean' });
  });

  it('reports clean when disk equals the expected emission (after-frontmatter placement)', () => {
    const expected = embedHeaderAfterFrontmatter(frontmattered, sources);
    assert.deepEqual(verifyAgainstExpected(expected, expected), { status: 'clean' });
  });

  it('reports clean across CRLF differences (Windows autocrlf checkout)', () => {
    const expected = embedHeader(body, sources, 'html');
    const crlfDisk = expected.replace(/\n/g, '\r\n');
    assert.deepEqual(verifyAgainstExpected(crlfDisk, expected), { status: 'clean' });
  });

  it('reports edited when the disk body was modified under an intact header', () => {
    const expected = embedHeader(body, sources, 'html');
    assert.deepEqual(verifyAgainstExpected(`${expected}\nuser-added line\n`, expected), {
      status: 'edited',
    });
  });

  it('reports edited when a frontmatter line was modified (BODY_HASH binds frontmatter)', () => {
    const expected = embedHeaderAfterFrontmatter(frontmattered, sources);
    const tampered = expected.replace('paths: ["src/**"]', 'paths: ["**"]');
    assert.notEqual(tampered, expected);
    assert.deepEqual(verifyAgainstExpected(tampered, expected), { status: 'edited' });
  });

  it('reports stale when disk is an intact emission of older canonical content', () => {
    const oldEmission = embedHeader('# old projected content\n', otherSources, 'html');
    const expected = embedHeader(body, sources, 'html');
    assert.deepEqual(verifyAgainstExpected(oldEmission, expected), { status: 'stale' });
  });

  it('reports stale when only the sources manifest changed (same body)', () => {
    const oldEmission = embedHeader(body, otherSources, 'html');
    const expected = embedHeader(body, sources, 'html');
    assert.deepEqual(verifyAgainstExpected(oldEmission, expected), { status: 'stale' });
  });

  it('reports unmanaged when disk has no header at the expected placement', () => {
    const expected = embedHeader(body, sources, 'html');
    assert.deepEqual(verifyAgainstExpected('# hand-written file\n', expected), {
      status: 'unmanaged',
    });
    const fmExpected = embedHeaderAfterFrontmatter(frontmattered, sources);
    assert.deepEqual(verifyAgainstExpected(frontmattered, fmExpected), { status: 'unmanaged' });
  });

  it('throws when the expected emission carries no header (internal misuse)', () => {
    assert.throws(() => verifyAgainstExpected('anything', '# headerless expected\n'), /header/);
  });
});

describe('constants', () => {
  it('exports HEADER_TAG and HASH_LEN per F2 acceptance criteria', () => {
    assert.equal(HEADER_TAG, '@generated SignedSource');
    assert.equal(HASH_LEN, 16);
  });
});

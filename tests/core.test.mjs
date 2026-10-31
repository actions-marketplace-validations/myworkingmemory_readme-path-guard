import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRepository } from '../src/core.mjs';

function run(markdown, paths = [], before = '', basePaths = paths, file = 'README.md') {
  return checkRepository({ baseFiles: { [file]: before }, headFiles: { [file]: markdown }, baseTree: basePaths, headTree: paths });
}

test('accepts existing inline, reference, shortcut and image destinations', () => {
  const result = run('[a](docs/a.md) [b][guide] [guide]\n\n![picture](images/a.png)\n\n[guide]: docs/b.md',
    ['docs/a.md', 'docs/b.md', 'images/a.png']);
  assert.deepEqual(result, { findings: [], checkedReadmes: 1, checkedLinks: 4 });
});

test('finds newly broken links, with stable block locations and useful resolution', () => {
  const result = run('# Heading\n\n[docs](docs/missing.md)\n\n![art](art/missing.png)', []);
  assert.deepEqual(result.findings, [
    { file: 'README.md', line: 3, target: 'docs/missing.md', resolved: 'docs/missing.md', reason: 'missing-path' },
    { file: 'README.md', line: 5, target: 'art/missing.png', resolved: 'art/missing.png', reason: 'missing-path' },
  ]);
});

test('ignores links in inline code, fenced code, indented code, and HTML', () => {
  const md = '`[fake](a)`\n\n```md\n[fake](b)\n```\n\n    [fake](c)\n\n<a href="d">raw</a>\n';
  assert.equal(run(md).checkedLinks, 0);
});

test('does not fetch or check external schemes, protocol-relative links and fragment/query-only references', () => {
  const md = '[a](https://example.com/a) [b](http://localhost) [c](mailto:a@example.com) [d](//example.com/a) [e](#anchor) [f](?view=1) [g](data:text/plain,hi) [h](javascript:alert(1)) [i](file:///etc/passwd)';
  assert.deepEqual(run(md), { findings: [], checkedReadmes: 1, checkedLinks: 0 });
});

test('allows directories derived from tree files and repository root', () => {
  assert.equal(run('[docs](docs) [root](/) [up](../)', ['docs/file.md'], '', [], 'folder/README.md').findings.length, 1);
  assert.equal(run('[docs](/docs/) [root](/)', ['docs/file.md']).findings.length, 0);
});

test('resolves nested README paths, dot segments, root-relative paths, and ignores anchors/queries on valid files', () => {
  const result = run('[root](/LICENSE) [next](../guide.md#intro) [self](./README.md?plain=1)',
    ['LICENSE', 'docs/guide.md', 'docs/api/README.md'], '', [], 'docs/api/README.md');
  assert.equal(result.findings.length, 0);
});

test('flags literal and percent-encoded traversal outside the repository', () => {
  const result = run('[a](../secrets) [b](%2E%2E/secrets) [c](/../secrets)');
  assert.deepEqual(result.findings.map(f => f.reason), ['outside-repository', 'outside-repository', 'outside-repository']);
});

test('handles encoded spaces, Unicode, literal percent, encoded separators and balanced parentheses', () => {
  const md = '[a](docs/a%20b.md) [b](docs/caf%C3%A9.md) [c](docs/%252e%252e.md) [d](docs%2Fa.md) [e](docs/a(b).md) [f](<docs/a b.md>)';
  const paths = ['docs/a b.md', 'docs/café.md', 'docs/%2e%2e.md', 'docs/a.md', 'docs/a(b).md'];
  assert.equal(run(md, paths).findings.length, 0);
});

test('handles malformed UTF-8 encoding and control bytes without crashing', () => {
  const result = run('[bad](docs/%FF.md) [null](a%00b.md) [line](a%0Ab.md)');
  assert.deepEqual(result.findings.map(f => [f.target, f.reason]), [
    ['a%00b.md', 'invalid-path'],
    ['a%0Ab.md', 'invalid-path'],
    ['docs/%FF.md', 'invalid-encoding'],
  ]);
});

test('CommonMark normalization preserves malformed literal percent as a literal path character', () => {
  assert.equal(run('[literal](docs/%GG.md)', ['docs/%GG.md']).findings.length, 0);
  const result = run('[literal](docs/%GG.md)');
  assert.equal(result.findings[0].resolved, 'docs/%GG.md');
});

test('catches a deleted or renamed target even when README text is unchanged', () => {
  const md = '[guide](docs/guide.md)';
  assert.equal(run(md, ['docs/new-guide.md'], md, ['docs/guide.md']).findings.length, 1);
});

test('suppresses pre-existing broken links when the README itself is renamed', () => {
  const md = '[old](already-missing.md)';
  const result = checkRepository({
    baseFiles: { 'README.md': md },
    headFiles: { 'README.markdown': md },
    baseTree: ['README.md'],
    headTree: ['README.markdown'],
    baseAliases: { 'README.markdown': 'README.md' },
  });
  assert.deepEqual(result, { findings: [], checkedReadmes: 1, checkedLinks: 1 });
});

test('README moves resolve baseline links at the prior directory and find newly broken paths', () => {
  const md = '[guide](guide.md)';
  const result = checkRepository({
    baseFiles: { 'docs/README.md': md },
    headFiles: { 'guides/README.md': md },
    baseTree: ['docs/README.md', 'docs/guide.md'],
    headTree: ['guides/README.md', 'docs/guide.md'],
    baseAliases: { 'guides/README.md': 'docs/README.md' },
  });
  assert.deepEqual(result.findings, [{
    file: 'guides/README.md', line: 1, target: 'guide.md', resolved: 'guides/guide.md', reason: 'missing-path',
  }]);
});

test('rejects noncanonical README base aliases', () => {
  assert.throws(() => checkRepository({
    headFiles: { 'README.md': '' }, baseAliases: { 'README.md': '../README.md' },
  }), TypeError);
});

test('suppresses pre-existing broken links but reports a different new target', () => {
  const result = run('[old](old.md)\n\n[new](new.md)', [], '[old](old.md)', []);
  assert.deepEqual(result.findings.map(f => f.target), ['new.md']);
});

test('deduplicates target failures within a README without losing link counts', () => {
  const result = run('[one](missing)\n\n[two](missing) ![image](missing)');
  assert.equal(result.findings.length, 1);
  assert.equal(result.checkedLinks, 3);
  assert.equal(result.findings[0].line, 1);
});

test('case-sensitive paths match Git repository behavior', () => {
  assert.equal(run('[a](Docs/Guide.md)', ['docs/guide.md']).findings.length, 1);
});

test('sorts findings deterministically by file, block line, and target', () => {
  const result = checkRepository({ headFiles: { 'z/README.md': '[z](z)', 'a/README.md': '[b](b) [a](a)' } });
  assert.deepEqual(result.findings.map(f => [f.file, f.target]), [['a/README.md', 'a'], ['a/README.md', 'b'], ['z/README.md', 'z']]);
});

test('malicious shell and HTML content remains data, never runs or renders', () => {
  const result = run('[a](<$(touch PWNED).md>)\n\n<script>alert(1)</script>\n\n[evil](javascript:alert(1))');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].resolved, '$(touch PWNED).md');
});

test('empty repository and removed READMEs are handled', () => {
  assert.deepEqual(checkRepository(), { findings: [], checkedReadmes: 0, checkedLinks: 0 });
  assert.equal(checkRepository({ baseFiles: { 'README.md': '[a](missing)' } }).findings.length, 0);
});

test('rejects noncanonical tree and README paths and invalid content inputs', () => {
  assert.throws(() => checkRepository({ headTree: ['../secret'] }), TypeError);
  assert.throws(() => checkRepository({ headTree: '/README.md' }), TypeError);
  assert.throws(() => checkRepository({ headFiles: { '../README.md': '' } }), TypeError);
  assert.throws(() => checkRepository({ headFiles: { 'README.md': null } }), TypeError);
});

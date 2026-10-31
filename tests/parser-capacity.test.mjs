import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRepositoryBounded } from '../src/check-in-worker.mjs';

const input = markdown => ({ baseFiles: {}, headFiles: { 'README.md': markdown }, baseTree: [], headTree: ['README.md', 'guide.md'] });

test('isolated checker preserves normal findings and stays available after a timeout', async () => {
  const result = await checkRepositoryBounded(input('[Guide](guide.md) [Missing](missing.md)'));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].target, 'missing.md');
  assert.equal(result.checkedLinks, 2);
});

test('accepted-size pathological bracket input is terminated instead of blocking the runner', async () => {
  await assert.rejects(checkRepositoryBounded(input('['.repeat(131072) + ']'.repeat(131072)), { timeoutMs: 500 }), { code: 'PARSER_LIMIT' });
  assert.equal((await checkRepositoryBounded(input('[Guide](guide.md)'))).findings.length, 0);
});

test('shallow but quadratic unmatched destinations are also bounded', async () => {
  await assert.rejects(checkRepositoryBounded(input('[a]('.repeat(65536)), { timeoutMs: 500 }), { code: 'PARSER_LIMIT' });
});

test('parser failures are generic and never include private input', async () => {
  await assert.rejects(checkRepositoryBounded({ headFiles: { 'PRIVATE_REPOSITORY': { secret: 'private-example' } } }), error => {
    assert.equal(error.code, 'PARSER_FAILURE');
    assert.ok(!error.message.includes('PRIVATE_REPOSITORY'));
    assert.ok(!error.message.includes('private-example'));
    return true;
  });
});

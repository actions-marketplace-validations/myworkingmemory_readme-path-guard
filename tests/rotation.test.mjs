import test from 'node:test';
import assert from 'node:assert/strict';
import { rotate, rotationSteps } from '../src/rotation.mjs';
test('mixed-radix rotation reaches every install/repo/PR as first work', () => {
  const seen = new Set();
  for (let epoch = 0; epoch < 3 * 4 * 5; epoch++) {
    const steps = rotationSteps(epoch, 3, 4);
    seen.add([rotate([0,1,2], steps.installation)[0], rotate([0,1,2,3], steps.repository)[0], rotate([0,1,2,3,4], steps.pull)[0]].join(':'));
  }
  assert.equal(seen.size, 60);
});
test('rotation preserves input and handles empty/single lists', () => {
  const input = [1,2,3];
  assert.deepEqual(rotate(input, 1), [2,3,1]);
  assert.deepEqual(input, [1,2,3]);
  assert.deepEqual(rotate([], 7), []);
  assert.deepEqual(rotate([1], 100), [1]);
});

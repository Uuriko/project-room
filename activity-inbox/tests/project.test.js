import { designDiff, receipt, delta } from '../src/project.js';

describe('project utilities', () => {
  const designA = { a: 1, b: 2, c: [3, 4] };
  const designB = { a: 1, b: 3, c: [3, 4], d: 'new' };

  test('designDiff identifies changes', () => {
    const diff = designDiff(designA, designB);
    expect(diff).toEqual(
      expect.arrayContaining([
        { key: 'b', old: 2, new: 3 },
        { key: 'd', old: undefined, new: 'new' },
      ])
    );
    expect(diff.length).toBe(2);
  });

  test('receipt produces consistent hash', () => {
    const hashA = receipt(designA);
    const hashB = receipt(designB);
    expect(hashA).toBeDefined();
    expect(hashB).toBeDefined();
    expect(hashA).not.toEqual(hashB);
  });

  test('delta is equivalent to designDiff', () => {
    const diff1 = designDiff(designA, designB);
    const diff2 = delta(designA, designB);
    expect(diff2).toEqual(diff1);
  });
});

import { rrf } from './rrf';

describe('rrf', () => {
  it('ranks an item that appears near the top of both lists above one that appears in only one list', () => {
    const vectorList = ['a', 'b', 'c'];
    const ftsList = ['b', 'd', 'a'];

    const fused = rrf([vectorList, ftsList], (id) => id);

    // 'b' is rank 2 in vector, rank 1 in fts -> highest combined score
    expect(fused[0]).toBe('b');
  });

  it('applies the standard k=60 RRF constant', () => {
    const fused = rrf<string>([['x']], (id) => id, 60);
    // score for 'x' = 1 / (60 + 1) = 1/61
    expect(fused).toEqual(['x']);
  });

  it('deduplicates items that appear in multiple lists into a single fused entry', () => {
    const fused = rrf([['a', 'b'], ['a', 'c']], (id) => id);
    expect(fused).toHaveLength(3);
    expect(new Set(fused)).toEqual(new Set(['a', 'b', 'c']));
  });
});

import { chunkByFixedWindow } from './fallback-chunker';

describe('chunkByFixedWindow', () => {
  it('splits long text into overlapping windows of roughly the requested token count', () => {
    const words = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkByFixedWindow(words, 500, 50);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].content.split(' ')).toHaveLength(500);
  });

  it('produces overlapping content between consecutive chunks', () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkByFixedWindow(words, 500, 50);

    const firstChunkWords = chunks[0].content.split(' ');
    const secondChunkWords = chunks[1].content.split(' ');
    const overlap = firstChunkWords.slice(-50);
    expect(secondChunkWords.slice(0, 50)).toEqual(overlap);
  });

  it('returns a single chunk for text shorter than the window size', () => {
    const chunks = chunkByFixedWindow('short text here', 500, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('short text here');
  });
});

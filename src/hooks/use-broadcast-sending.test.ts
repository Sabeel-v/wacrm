import { describe, it, expect } from 'vitest';
import { chunkArray, CHUNK_SIZE, BATCH_DELAY_MS } from './use-broadcast-sending';

describe('Frontend Chunked Batching Utilities', () => {
  it('has appropriate default chunk size and delay for Vercel Free Tier', () => {
    expect(CHUNK_SIZE).toBe(50);
    expect(BATCH_DELAY_MS).toBeGreaterThanOrEqual(1500);
    expect(BATCH_DELAY_MS).toBeLessThanOrEqual(2000);
  });

  it('slices an array of recipients into chunks of defined size', () => {
    const list = Array.from({ length: 125 }, (_, i) => ({ phone: `+1555000${i}` }));
    const chunks = chunkArray(list, 50);

    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(50);
    expect(chunks[1].length).toBe(50);
    expect(chunks[2].length).toBe(25);
  });

  it('handles 3,000 recipients gracefully', () => {
    const list = Array.from({ length: 3000 }, (_, i) => ({ phone: `+1555${i}` }));
    const chunks = chunkArray(list, 50);

    expect(chunks.length).toBe(60);
    expect(chunks.every((c) => c.length === 50)).toBe(true);
  });

  it('returns empty array when list is empty or size is invalid', () => {
    expect(chunkArray([], 50)).toEqual([]);
    expect(chunkArray([1, 2, 3], 0)).toEqual([]);
    expect(chunkArray([1, 2, 3], -5)).toEqual([]);
  });

  it('handles lists smaller than the chunk size', () => {
    const list = [{ phone: '+1234567890' }, { phone: '+1234567891' }];
    const chunks = chunkArray(list, 50);

    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(2);
  });
});

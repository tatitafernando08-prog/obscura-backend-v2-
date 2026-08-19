import { ExtractedChunk } from './gemini-extractor';

export function chunkByFixedWindow(text: string, windowTokens = 500, overlapTokens = 50): ExtractedChunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= windowTokens) {
    return [{ content: words.join(' ') }];
  }

  const chunks: ExtractedChunk[] = [];
  const stride = windowTokens - overlapTokens;
  for (let start = 0; start < words.length; start += stride) {
    const windowWords = words.slice(start, start + windowTokens);
    if (windowWords.length === 0) break;
    chunks.push({ content: windowWords.join(' ') });
    if (start + windowTokens >= words.length) break;
  }
  return chunks;
}

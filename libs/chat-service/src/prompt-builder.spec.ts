import { buildPrompt } from './prompt-builder';

describe('buildPrompt', () => {
  const baseInput = {
    questionText: 'What is the law of demand?',
    medium: 'english',
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hey!' }],
    chunks: [{ index: 1, content: 'The law of demand states...', subject: 'Economics', year: 2022 }],
  };

  it('numbers excerpts starting at 1 and includes their content', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('[1] The law of demand states...');
  });

  it('instructs the model to answer in the requested medium', () => {
    const prompt = buildPrompt({ ...baseInput, medium: 'sinhala' });
    expect(prompt).toMatch(/sinhala/i);
  });

  it('includes the hard grounding rule: decline rather than answer from general knowledge when ungrounded', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toMatch(/do not (use|answer from) (outside|general) knowledge/i);
  });

  it('requests structured JSON output with answer, is_curriculum_question, cited_indices', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('is_curriculum_question');
    expect(prompt).toContain('cited_indices');
  });

  it('includes chat history in order', () => {
    const prompt = buildPrompt(baseInput);
    const hiIndex = prompt.indexOf('hi');
    const heyIndex = prompt.indexOf('Hey!');
    expect(hiIndex).toBeGreaterThan(-1);
    expect(heyIndex).toBeGreaterThan(hiIndex);
  });

  it('adds a stricter cite-or-decline instruction when strict=true', () => {
    const normal = buildPrompt(baseInput);
    const strict = buildPrompt({ ...baseInput, strict: true });
    expect(strict.length).toBeGreaterThan(normal.length);
    expect(strict).toMatch(/must (cite|decline)/i);
  });

  it('handles zero retrieved chunks by instructing a decline for curriculum questions', () => {
    const prompt = buildPrompt({ ...baseInput, chunks: [] });
    expect(prompt).toMatch(/no excerpts/i);
  });
});

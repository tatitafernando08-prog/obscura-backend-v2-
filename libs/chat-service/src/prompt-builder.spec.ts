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
    expect(prompt).toContain('The law of demand states...');
    expect(prompt).toMatch(/\[1\][^\n]*The law of demand states\.\.\./);
  });

  it('includes each excerpt\'s subject and year so the model can cite them by name', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toMatch(/\[1\][^\n]*Economics[^\n]*2022/);
  });

  it('instructs the model to answer in the requested medium', () => {
    const prompt = buildPrompt({ ...baseInput, medium: 'sinhala' });
    expect(prompt).toMatch(/sinhala/i);
  });

  it('includes the labeled-fallback rule: general knowledge answers must be flagged, not declined', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).not.toMatch(/do not (use|answer from) (outside|general) knowledge/i);
    expect(prompt).toMatch(/do not decline/i);
    expect(prompt).toMatch(/couldn't find this in your past papers, but here's a general explanation/i);
    expect(prompt).toMatch(/cited_indices to an empty array/i);
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

  it('adds a stricter cite-or-labeled-fallback instruction when strict=true', () => {
    const normal = buildPrompt(baseInput);
    const strict = buildPrompt({ ...baseInput, strict: true });
    expect(strict.length).toBeGreaterThan(normal.length);
    expect(strict).toMatch(/must (cite|.*general knowledge)/i);
    expect(strict).not.toMatch(/must (cite|decline)/i);
  });

  it('handles zero retrieved chunks by rendering the no-excerpts placeholder', () => {
    const prompt = buildPrompt({ ...baseInput, chunks: [] });
    expect(prompt).toMatch(/no excerpts/i);
  });

  it('instructs a warm, tutor-like tone rather than a formal report', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toMatch(/tutor/i);
  });

  it('instructs expanded, multi-paragraph explanations over bare definitions', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toMatch(/paragraphs/i);
  });

  it('instructs naming the excerpt source naturally inline in the answer', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toMatch(/name (its|the) source/i);
  });

  it('instructs quoting the excerpt\'s original exam wording when relevant', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toMatch(/quote/i);
    expect(prompt).toMatch(/how it (was|is) (actually )?(asked|phrased)/i);
  });
});

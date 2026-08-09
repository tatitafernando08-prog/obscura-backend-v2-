export interface PromptChunk {
  index: number;
  content: string;
  subject: string;
  year: number;
}

export interface PromptInput {
  questionText: string;
  medium: string;
  history: { role: string; content: string }[];
  chunks: PromptChunk[];
  strict?: boolean;
}

export function buildPrompt(input: PromptInput): string {
  const excerptsBlock = input.chunks.length
    ? input.chunks.map((c) => `[${c.index}] ${c.content}`).join('\n\n')
    : '(no excerpts were retrieved for this question)';

  const historyBlock = input.history.length
    ? input.history.map((h) => `${h.role}: ${h.content}`).join('\n')
    : '(no prior turns)';

  const strictClause = input.strict
    ? `\nSTRICT MODE: Your previous attempt at this question produced no citations for what was judged a curriculum-content question. You must cite or decline: either (a) cite at least one of the excerpts above by index in cited_indices, or (b) set is_curriculum_question=true and decline with the localized message "I don't have that in the past papers I have yet", with an empty cited_indices array. Do not answer from general knowledge.`
    : '';

  return `You are NESH, an AI study assistant for Sri Lankan O/L and A/L students.

RULES:
1. Answer ONLY using the numbered EXCERPTS below when the question is about curriculum content (a subject, topic, or exam-style question). Do not answer from general knowledge for curriculum content questions.
2. If none of the EXCERPTS are relevant to the question, and the question is curriculum content, respond with the localized equivalent of "I don't have that in the past papers I have yet" and set cited_indices to an empty array.
3. If you use an excerpt, you must list its number in cited_indices.
4. For small talk or meta questions (greetings, "what can you help with", etc.), answer normally, set is_curriculum_question=false, and leave cited_indices empty — no citation is required for these.
5. Always answer in this language regardless of the excerpts' language: ${input.medium}.
6. Respond with ONLY a JSON object of the shape: {"answer": string, "is_curriculum_question": boolean, "cited_indices": number[]}.
${strictClause}

EXCERPTS:
${excerptsBlock}

CHAT HISTORY:
${historyBlock}

QUESTION:
${input.questionText}`;
}

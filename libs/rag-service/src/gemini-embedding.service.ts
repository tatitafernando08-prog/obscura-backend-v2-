import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { EnvConfig } from '@app/common';

export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

@Injectable()
export class GeminiEmbeddingService {
  private readonly client: GoogleGenerativeAI;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.client = new GoogleGenerativeAI(config.get('GEMINI_API_KEY', { infer: true }));
  }

  async embed(text: string, taskType: EmbeddingTaskType): Promise<number[]> {
    const model = this.client.getGenerativeModel({ model: 'models/gemini-embedding-001' });
    const result = await model.embedContent({
      content: { role: 'user', parts: [{ text }] },
      taskType: taskType as any,
      outputDimensionality: 768,
    } as any);
    return result.embedding.values;
  }
}

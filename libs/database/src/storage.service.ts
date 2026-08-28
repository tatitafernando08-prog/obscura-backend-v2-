import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as WebSocket from 'ws';
import { EnvConfig } from '@app/common';

const BUCKET = 'papers';

@Injectable()
export class StorageService {
  private readonly client: SupabaseClient;

  constructor(config: ConfigService<EnvConfig, true>) {
    // supabase-js always constructs a RealtimeClient, which throws at
    // construction time on Node < 22 (no global WebSocket) unless a
    // transport is supplied — even though this service never uses realtime.
    this.client = createClient(
      config.get('SUPABASE_URL', { infer: true }),
      config.get('SUPABASE_SERVICE_ROLE_KEY', { infer: true }),
      { realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket } },
    );
  }

  async uploadPdf(path: string, buffer: Buffer): Promise<void> {
    const { error } = await this.client.storage
      .from(BUCKET)
      .upload(path, buffer, {
        contentType: 'application/pdf',
        upsert: false,
      });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async downloadPdf(path: string): Promise<Buffer> {
    const { data, error } = await this.client.storage
      .from(BUCKET)
      .download(path);
    if (error || !data)
      throw new Error(`Storage download failed: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async deletePdf(path: string): Promise<void> {
    await this.client.storage.from(BUCKET).remove([path]);
  }
}

import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

@Injectable()
export class ChatSessionsRepository {
  constructor(private readonly db: DatabaseService) {}

  async getOrCreateForStudent(studentId: string): Promise<string> {
    const existing = await this.db.query<{ id: string }>(
      `select id from chat_sessions where student_id = $1 order by created_at desc limit 1`,
      [studentId],
    );
    if (existing[0]) return existing[0].id;

    const created = await this.db.query<{ id: string }>(
      `insert into chat_sessions (student_id) values ($1) returning id`,
      [studentId],
    );
    return created[0].id;
  }

  async getOrCreateForDevice(deviceId: string): Promise<string> {
    const existing = await this.db.query<{ id: string }>(
      `select id from chat_sessions where device_id = $1 order by created_at desc limit 1`,
      [deviceId],
    );
    if (existing[0]) return existing[0].id;

    const created = await this.db.query<{ id: string }>(
      `insert into chat_sessions (device_id) values ($1) returning id`,
      [deviceId],
    );
    return created[0].id;
  }

  async appendMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    sources?: { subject: string; year: string }[],
    grounded?: boolean,
  ): Promise<void> {
    await this.db.query(
      `insert into chat_messages (session_id, role, content, sources, grounded) values ($1, $2, $3, $4, $5)`,
      [
        sessionId,
        role,
        content,
        sources ? JSON.stringify(sources) : null,
        grounded ?? null,
      ],
    );
  }

  async getRecentHistory(sessionId: string, limit = 6): Promise<HistoryTurn[]> {
    const rows = await this.db.query<HistoryTurn>(
      `select role, content from chat_messages
       where session_id = $1
       order by created_at desc
       limit $2`,
      [sessionId, limit],
    );
    return rows.reverse();
  }
}

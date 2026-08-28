import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database.service';
import { ChatSessionsRepository } from './chat-sessions.repository';

describe('ChatSessionsRepository', () => {
  let db: DatabaseService;
  let repo: ChatSessionsRepository;
  const studentId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, ChatSessionsRepository],
    }).compile();
    db = moduleRef.get(DatabaseService);
    repo = moduleRef.get(ChatSessionsRepository);

    await db.query(
      `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
      [studentId, `${studentId}@example.com`],
    );
    await db.query(`insert into students (id, email) values ($1, $2)`, [
      studentId,
      `${studentId}@example.com`,
    ]);
  });

  afterAll(async () => {
    // chat_sessions.student_id has no ON DELETE CASCADE from students, so the session
    // rows must be removed explicitly first; chat_messages then cascades from chat_sessions.
    await db.query('delete from chat_sessions where student_id = $1', [
      studentId,
    ]);
    await db.query('delete from students where id = $1', [studentId]);
    await db.query('delete from auth.users where id = $1', [studentId]);
  });

  it('creates a new session on first call and reuses it on subsequent calls for the same student', async () => {
    const first = await repo.getOrCreateForStudent(studentId);
    const second = await repo.getOrCreateForStudent(studentId);
    expect(second).toBe(first);
  });

  it('appends messages and returns the last N in chronological order', async () => {
    const sessionId = await repo.getOrCreateForStudent(studentId);
    await repo.appendMessage(sessionId, 'user', 'What is demand?');
    await repo.appendMessage(
      sessionId,
      'assistant',
      'Demand is...',
      [{ subject: 'Economics', year: '2022' }],
      true,
    );

    const history = await repo.getRecentHistory(sessionId, 6);
    expect(history.map((h) => h.role)).toEqual(['user', 'assistant']);
    expect(history[0].content).toBe('What is demand?');

    const rows = await db.query<{ grounded: boolean }>(
      `select grounded from chat_messages where session_id = $1 and role = 'assistant' order by created_at desc limit 1`,
      [sessionId],
    );
    expect(rows[0].grounded).toBe(true);
  });

  it('caps history at the requested limit, keeping the most recent turns', async () => {
    const sessionId = await repo.getOrCreateForStudent(studentId);
    for (let i = 0; i < 10; i++) {
      await repo.appendMessage(
        sessionId,
        i % 2 === 0 ? 'user' : 'assistant',
        `turn ${i}`,
      );
    }
    const history = await repo.getRecentHistory(sessionId, 6);
    expect(history).toHaveLength(6);
    expect(history[history.length - 1].content).toBe('turn 9');
  }, 20000);
});

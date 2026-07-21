import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database.service';
import { StudentsRepository } from './students.repository';

describe('StudentsRepository', () => {
  let db: DatabaseService;
  let repo: StudentsRepository;
  const testId = randomUUID();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [DatabaseService, StudentsRepository],
    }).compile();
    db = moduleRef.get(DatabaseService);
    repo = moduleRef.get(StudentsRepository);

    // students.id has a FK to auth.users(id); insert a matching auth.users row first
    // so this test can insert into students without violating the constraint.
    await db.query(
      `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
      [testId, `test-${testId}@example.com`],
    );
  });

  afterAll(async () => {
    await db.query('delete from students where id = $1', [testId]);
    await db.query('delete from auth.users where id = $1', [testId]);
  });

  it('returns null for a student that does not exist', async () => {
    const result = await repo.findById(randomUUID());
    expect(result).toBeNull();
  });

  it('finds a student by id after insert, defaulting role to student', async () => {
    await db.query(
      `insert into students (id, email, name) values ($1, $2, $3)`,
      [testId, 'test@example.com', 'Test Student'],
    );

    const found = await repo.findById(testId);
    expect(found).toMatchObject({ id: testId, email: 'test@example.com', role: 'student' });

    const role = await repo.getRole(testId);
    expect(role).toBe('student');
  });
});

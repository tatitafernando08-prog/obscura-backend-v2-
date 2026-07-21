import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';

export interface Student {
  id: string;
  email: string | null;
  name: string | null;
  grade: string | null;
  syllabus: string | null;
  medium: string | null;
  stream: string | null;
  role: 'student' | 'admin';
}

@Injectable()
export class StudentsRepository {
  constructor(private readonly db: DatabaseService) {}

  async findById(id: string): Promise<Student | null> {
    const rows = await this.db.query<Student>(
      `select id, email, name, grade, syllabus, medium, stream, role
       from students where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async getRole(id: string): Promise<'student' | 'admin' | null> {
    const student = await this.findById(id);
    return student?.role ?? null;
  }
}

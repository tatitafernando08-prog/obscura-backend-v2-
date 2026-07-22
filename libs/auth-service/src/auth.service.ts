import { Injectable } from '@nestjs/common';
import { JwtVerifierService } from './jwt-verifier.service';
import { StudentsRepository } from '@app/database';

export interface Principal {
  type: 'student' | 'admin';
  id: string;
  role: 'student' | 'admin';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtVerifier: JwtVerifierService,
    private readonly students: StudentsRepository,
  ) {}

  async resolvePrincipal(token: string): Promise<Principal | null> {
    const decoded = await this.jwtVerifier.verify(token);
    if (!decoded) return null;

    const student = await this.students.findById(decoded.sub);
    if (!student) return null;

    return { type: student.role, id: student.id, role: student.role };
  }
}

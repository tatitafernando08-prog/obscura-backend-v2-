import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { StudentsRepository } from './repositories/students.repository';
import { ChatSessionsRepository } from './repositories/chat-sessions.repository';

@Global()
@Module({
  providers: [DatabaseService, StudentsRepository, ChatSessionsRepository],
  exports: [DatabaseService, StudentsRepository, ChatSessionsRepository],
})
export class DatabaseModule {}

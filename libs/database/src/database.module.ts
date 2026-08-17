import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { StorageService } from './storage.service';
import { StudentsRepository } from './repositories/students.repository';
import { ChatSessionsRepository } from './repositories/chat-sessions.repository';

@Global()
@Module({
  providers: [
    DatabaseService,
    StorageService,
    StudentsRepository,
    ChatSessionsRepository,
  ],
  exports: [
    DatabaseService,
    StorageService,
    StudentsRepository,
    ChatSessionsRepository,
  ],
})
export class DatabaseModule {}

import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { StudentsRepository } from './repositories/students.repository';

@Global()
@Module({
  providers: [DatabaseService, StudentsRepository],
  exports: [DatabaseService, StudentsRepository],
})
export class DatabaseModule {}

import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { AuthServiceModule } from '@app/auth-service';

@Module({
  imports: [AppConfigModule, DatabaseModule, AuthServiceModule],
})
export class AppModule {}

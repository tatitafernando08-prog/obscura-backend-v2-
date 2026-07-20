import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/common';

@Module({
  imports: [AppConfigModule],
})
export class AppModule {}

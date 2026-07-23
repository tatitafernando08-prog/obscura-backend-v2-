import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'path';
import { AppModule } from './app.module';
import { EnvConfig } from '@app/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<EnvConfig, true>);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'auth',
      protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
      url: config.get('AUTH_GRPC_URL', { infer: true }),
    },
  });

  await app.startAllMicroservices();
  await app.listen(config.get('PORT', { infer: true }));
}
bootstrap();

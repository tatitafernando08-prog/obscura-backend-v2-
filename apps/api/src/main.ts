import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Transport, MicroserviceOptions } from '@nestjs/microservices';
import { join } from 'path';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { EnvConfig } from '@app/common';
import { RequestIdInterceptor } from '@app/gateway';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<EnvConfig, true>);

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'auth',
      protoPath: join(process.cwd(), 'libs/proto/src/auth.proto'),
      url: config.get('AUTH_GRPC_URL', { infer: true }),
    },
  });

  app.use(helmet());
  app.enableCors({ origin: true, credentials: true }); // TODO: restrict to real web-client origin once §1's website client exists
  app.useGlobalInterceptors(new RequestIdInterceptor());

  await app.startAllMicroservices();
  await app.listen(config.get('PORT', { infer: true }));
}
bootstrap();

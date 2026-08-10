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

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'rag',
      protoPath: join(process.cwd(), 'libs/proto/src/rag.proto'),
      url: config.get('RAG_GRPC_URL', { infer: true }),
      // proto3 omits empty repeated fields on the wire, and @grpc/proto-loader
      // defaults to leaving them `undefined` on decode rather than `[]`.
      // `arrays: true` restores `[]` for a no-match Search response so
      // downstream consumers (Task 27's grounding check) can rely on
      // `response.chunks` always being an array.
      loader: { arrays: true },
    },
  });

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: 'chat',
      protoPath: join(process.cwd(), 'libs/proto/src/chat.proto'),
      url: config.get('CHAT_GRPC_URL', { infer: true }),
      // chat.proto imports rag.proto, so proto-loader needs includeDirs to
      // resolve that import. Also needs arrays:true (see rag block above)
      // since AskRequest/AskResponse both have repeated fields.
      loader: { arrays: true, includeDirs: [join(process.cwd(), 'libs/proto/src')] },
    },
  });

  app.use(helmet());
  app.enableCors({ origin: true, credentials: true }); // TODO: restrict to real web-client origin once §1's website client exists
  app.useGlobalInterceptors(new RequestIdInterceptor());

  await app.startAllMicroservices();
  await app.listen(config.get('PORT', { infer: true }));
}
bootstrap();

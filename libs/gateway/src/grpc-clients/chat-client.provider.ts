import { Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport, ClientGrpc } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { EnvConfig } from '@app/common';
import { ChatLlmServiceClient } from '@app/proto/generated/chat';

export const CHAT_GRPC_CLIENT = 'CHAT_GRPC_CLIENT';

export const chatClientProvider: Provider = {
  provide: CHAT_GRPC_CLIENT,
  useFactory: (config: ConfigService<EnvConfig, true>): ChatLlmServiceClient => {
    const client: ClientGrpc = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'chat',
        protoPath: join(process.cwd(), 'libs/proto/src/chat.proto'),
        url: config.get('CHAT_GRPC_URL', { infer: true }),
        // chat.proto imports rag.proto, so proto-loader needs includeDirs to
        // resolve that import. Also needs arrays:true since AskRequest/
        // AskResponse both have repeated fields, matching the server-side
        // `chat` block in apps/api/src/main.ts.
        loader: { arrays: true, includeDirs: [join(process.cwd(), 'libs/proto/src')] },
      },
    }) as unknown as ClientGrpc;
    return client.getService<ChatLlmServiceClient>('ChatLlmService');
  },
  inject: [ConfigService],
};

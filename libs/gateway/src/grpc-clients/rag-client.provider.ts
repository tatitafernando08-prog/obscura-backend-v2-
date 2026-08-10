import { Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport, ClientGrpc } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { EnvConfig } from '@app/common';
import { RagServiceClient } from '@app/proto/generated/rag';

export const RAG_GRPC_CLIENT = 'RAG_GRPC_CLIENT';

export const ragClientProvider: Provider = {
  provide: RAG_GRPC_CLIENT,
  useFactory: (config: ConfigService<EnvConfig, true>): RagServiceClient => {
    const client: ClientGrpc = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'rag',
        protoPath: join(process.cwd(), 'libs/proto/src/rag.proto'),
        url: config.get('RAG_GRPC_URL', { infer: true }),
        // proto3 omits empty repeated fields on the wire, and @grpc/proto-loader
        // defaults to leaving them `undefined` on decode rather than `[]`.
        // `arrays: true` restores `[]` for a no-match Search response, matching
        // the server-side `rag` block in apps/api/src/main.ts.
        loader: { arrays: true },
      },
    }) as unknown as ClientGrpc;
    return client.getService<RagServiceClient>('RagService');
  },
  inject: [ConfigService],
};

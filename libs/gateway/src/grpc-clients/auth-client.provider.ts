import { Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport, ClientGrpc } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { EnvConfig } from '@app/common';
import { AuthServiceClient } from '@app/proto/generated/auth';

export const AUTH_GRPC_CLIENT = 'AUTH_GRPC_CLIENT';

export const authClientProvider: Provider = {
  provide: AUTH_GRPC_CLIENT,
  useFactory: (config: ConfigService<EnvConfig, true>): AuthServiceClient => {
    const client: ClientGrpc = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'auth',
        protoPath: join(process.cwd(), 'libs/proto/src/auth.proto'),
        url: config.get('AUTH_GRPC_URL', { infer: true }),
      },
    }) as unknown as ClientGrpc;
    return client.getService<AuthServiceClient>('AuthService');
  },
  inject: [ConfigService],
};

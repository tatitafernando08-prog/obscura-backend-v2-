import { Provider } from '@nestjs/common';
import { ClientProxyFactory, Transport, ClientGrpc } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { EnvConfig } from '@app/common';
import { SpeechServiceClient } from '@app/proto/generated/speech';

export const SPEECH_GRPC_CLIENT = 'SPEECH_GRPC_CLIENT';

export const speechClientProvider: Provider = {
  provide: SPEECH_GRPC_CLIENT,
  useFactory: (config: ConfigService<EnvConfig, true>): SpeechServiceClient => {
    const client: ClientGrpc = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'speech',
        protoPath: join(process.cwd(), 'libs/proto/src/speech.proto'),
        url: config.get('SPEECH_GRPC_URL', { infer: true }),
      },
    }) as unknown as ClientGrpc;
    return client.getService<SpeechServiceClient>('SpeechService');
  },
  inject: [ConfigService],
};

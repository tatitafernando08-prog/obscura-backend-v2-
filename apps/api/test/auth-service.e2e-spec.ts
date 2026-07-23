import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Transport, MicroserviceOptions, ClientGrpc, ClientProxyFactory } from '@nestjs/microservices';
import { join } from 'path';
import { firstValueFrom } from 'rxjs';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { AuthServiceClient } from '@app/proto/generated/auth';

describe('Auth Service (gRPC e2e)', () => {
  let app: INestApplication;
  let client: AuthServiceClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: 'auth',
        protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
        url: '127.0.0.1:50061', // distinct test port
      },
    });
    await app.startAllMicroservices();
    await app.init();

    const grpcClient: ClientGrpc = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'auth',
        protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
        url: '127.0.0.1:50061',
      },
    }) as unknown as ClientGrpc;
    client = grpcClient.getService<AuthServiceClient>('AuthService');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns valid:false for a garbage token', async () => {
    const result = await firstValueFrom(client.verifyToken({ token: 'not-a-jwt' }));
    expect(result.valid).toBe(false);
  });
});

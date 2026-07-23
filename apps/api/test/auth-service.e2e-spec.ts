import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Transport, MicroserviceOptions, ClientGrpc, ClientProxyFactory } from '@nestjs/microservices';
import { join } from 'path';
import { firstValueFrom } from 'rxjs';
import { AppModule } from '../src/app.module';
import { AuthServiceClient } from '@app/proto/generated/auth';
import { AuthService } from '@app/auth-service';

describe('Auth Service (gRPC e2e)', () => {
  let app: INestApplication;
  let client: AuthServiceClient;

  const grpcOptions = {
    transport: Transport.GRPC as const,
    options: {
      package: 'auth',
      protoPath: join(__dirname, '../../../libs/proto/src/auth.proto'),
      url: '127.0.0.1:50061', // distinct test port
    },
  };

  beforeAll(async () => {
    const mockAuthService = {
      resolvePrincipal: jest.fn().mockImplementation((token: string) => {
        // Return null for invalid tokens
        if (token === 'not-a-jwt') {
          return Promise.resolve(null);
        }
        // Return a valid principal for valid tokens
        return Promise.resolve({
          type: 'student',
          id: 'test-student-id',
          role: 'student',
        });
      }),
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthService)
      .useValue(mockAuthService)
      .compile();
    app = moduleRef.createNestApplication();

    app.connectMicroservice<MicroserviceOptions>(grpcOptions);
    await app.startAllMicroservices();
    await app.init();

    const grpcClient: ClientGrpc = ClientProxyFactory.create(grpcOptions) as unknown as ClientGrpc;
    client = grpcClient.getService<AuthServiceClient>('AuthService');
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns valid:false for a garbage token', async () => {
    const result = await firstValueFrom(client.verifyToken({ token: 'not-a-jwt' }));
    expect(result.valid).toBe(false);
  });

  it('returns valid:true and correctly serializes Principal over gRPC wire for a valid token', async () => {
    const result = await firstValueFrom(client.verifyToken({ token: 'irrelevant-because-stubbed' }));
    expect(result.valid).toBe(true);
    expect(result.principal).toEqual({
      type: 'student',
      id: 'test-student-id',
      role: 'student',
    });
  });
});

import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { StorageService } from './storage.service';

describe('StorageService (integration, real Supabase Storage)', () => {
  let service: StorageService;
  const testPath = `test/${Date.now()}.pdf`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [StorageService],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    await service.deletePdf(testPath);
  });

  it('round-trips a PDF buffer through upload and download', async () => {
    const original = Buffer.from('%PDF-1.4 fake pdf content for testing');
    await service.uploadPdf(testPath, original);
    const downloaded = await service.downloadPdf(testPath);
    expect(downloaded.equals(original)).toBe(true);
  });
});

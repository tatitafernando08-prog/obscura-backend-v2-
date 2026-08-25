import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { VoiceAskQueryDto } from './voice-ask-query.dto';

describe('VoiceAskQueryDto', () => {
  it('accepts a valid query with subject and medium', async () => {
    const dto = plainToInstance(VoiceAskQueryDto, { subject: 'Economics', medium: 'english' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a missing subject (optional, per the existing wire contract)', async () => {
    const dto = plainToInstance(VoiceAskQueryDto, { medium: 'english' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a missing medium', async () => {
    const dto = plainToInstance(VoiceAskQueryDto, { subject: 'Economics' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'medium')).toBe(true);
  });

  it('rejects a non-string medium', async () => {
    const dto = plainToInstance(VoiceAskQueryDto, { medium: 12345 as unknown });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'medium')).toBe(true);
  });
});

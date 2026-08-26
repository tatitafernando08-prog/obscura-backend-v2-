import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { FlashcardsGenerateDto } from './flashcards-generate.dto';

const VALID = {
  student_id: 'a5b1e9d0-1234-4abc-9def-000000000000',
  subject: 'Chemistry',
  level: 'AL',
  stream: 'Bio',
  syllabus: 'local',
  medium: 'english',
  count: 10,
};

describe('FlashcardsGenerateDto', () => {
  it('accepts a valid request matching the frontend contract', async () => {
    const dto = plainToInstance(FlashcardsGenerateDto, VALID);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it.each(['subject', 'level', 'stream', 'syllabus', 'medium'])(
    'rejects a missing %s',
    async (field) => {
      const dto = plainToInstance(FlashcardsGenerateDto, { ...VALID, [field]: undefined });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === field)).toBe(true);
    },
  );

  it('rejects a non-integer count', async () => {
    const dto = plainToInstance(FlashcardsGenerateDto, { ...VALID, count: 3.5 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'count')).toBe(true);
  });

  it('rejects a count of zero or below', async () => {
    const dto = plainToInstance(FlashcardsGenerateDto, { ...VALID, count: 0 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'count')).toBe(true);
  });

  it('rejects an unreasonably large count (abuse guard against the shared quota)', async () => {
    const dto = plainToInstance(FlashcardsGenerateDto, { ...VALID, count: 500 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'count')).toBe(true);
  });
});

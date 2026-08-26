import { IsInt, IsString, Max, Min } from 'class-validator';

const MAX_COUNT = 20; // abuse guard -- one Gemini call already asks for `count` cards at once

export class FlashcardsGenerateDto {
  // Convenience/logging only -- the authoritative student id is derived from
  // the verified JWT (AuthGuard's req.principal.id), never trusted from here,
  // since this is a shared endpoint against a scarce daily quota.
  @IsString()
  student_id!: string;

  @IsString()
  subject!: string;

  // Frontend sends 'OL'/'AL' (profile.exam_type); papers.level is stored
  // lowercase ('ol'/'al') -- normalized where this DTO is consumed, not here.
  @IsString()
  level!: string;

  @IsString()
  stream!: string;

  @IsString()
  syllabus!: string;

  @IsString()
  medium!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_COUNT)
  count!: number;
}

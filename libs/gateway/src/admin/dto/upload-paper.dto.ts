import { IsIn, IsOptional, IsString, IsNumberString } from 'class-validator';

export class UploadPaperDto {
  @IsString()
  subject!: string;

  @IsOptional() @IsNumberString()
  year?: string;

  @IsOptional() @IsString()
  syllabus?: string;

  @IsOptional() @IsIn(['ol', 'al'])
  level?: string;

  @IsOptional() @IsString()
  medium?: string;
}

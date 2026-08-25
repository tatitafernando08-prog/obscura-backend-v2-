import { IsOptional, IsString } from 'class-validator';

export class VoiceAskQueryDto {
  @IsOptional() @IsString()
  subject?: string;

  @IsString()
  medium!: string;
}

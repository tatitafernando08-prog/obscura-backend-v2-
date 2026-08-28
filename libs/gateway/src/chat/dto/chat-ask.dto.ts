import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

class ChatHistoryTurnDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  content!: string;
}

export class ChatAskDto {
  @IsString()
  question!: string;

  @IsOptional() @IsString()
  stream?: string;

  @IsOptional() @IsString()
  subject?: string;

  @IsOptional() @IsString()
  syllabus?: string;

  @IsString()
  medium!: string;

  @IsString()
  student_id!: string;

  @IsOptional() @IsArray()
  chat_history?: ChatHistoryTurnDto[];
}

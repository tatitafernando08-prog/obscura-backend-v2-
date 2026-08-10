import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatLlmAskService } from './ask.service';
import { GeminiChatService } from './gemini-chat.service';

@Module({
  controllers: [ChatController],
  providers: [ChatLlmAskService, GeminiChatService],
})
export class ChatServiceModule {}

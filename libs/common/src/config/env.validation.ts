import * as Joi from 'joi';

export interface EnvConfig {
  NODE_ENV: string;
  PORT: number;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWKS_URL: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  GEMINI_API_KEY: string;
  COHERE_API_KEY: string;
  GOOGLE_APPLICATION_CREDENTIALS: string;
  AUTH_GRPC_URL: string;
  RAG_GRPC_URL: string;
  CHAT_GRPC_URL: string;
  SPEECH_GRPC_URL: string;
}

export const envValidationSchema = Joi.object<EnvConfig, true>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),
  SUPABASE_URL: Joi.string().uri().required(),
  SUPABASE_ANON_KEY: Joi.string().required(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.string().required(),
  SUPABASE_JWKS_URL: Joi.string().uri().required(),
  DATABASE_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().required(),
  GEMINI_API_KEY: Joi.string().required(),
  COHERE_API_KEY: Joi.string().required(),
  GOOGLE_APPLICATION_CREDENTIALS: Joi.string().required(),
  AUTH_GRPC_URL: Joi.string().default('127.0.0.1:50051'),
  RAG_GRPC_URL: Joi.string().default('127.0.0.1:50052'),
  CHAT_GRPC_URL: Joi.string().default('127.0.0.1:50053'),
  SPEECH_GRPC_URL: Joi.string().default('127.0.0.1:50054'),
}).unknown(true);

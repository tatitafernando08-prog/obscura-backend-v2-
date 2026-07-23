import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { tap } from 'rxjs/operators';

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();
    const requestId: string = request.headers['x-request-id'] ?? randomUUID();
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    return next.handle().pipe(tap());
  }
}

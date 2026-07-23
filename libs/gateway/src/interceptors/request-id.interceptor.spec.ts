import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { RequestIdInterceptor } from './request-id.interceptor';

describe('RequestIdInterceptor', () => {
  const interceptor = new RequestIdInterceptor();

  function buildContext(headers: Record<string, string>) {
    const request: any = { headers };
    const response: any = { setHeader: jest.fn() };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('ok') };
    return { request, response, context, next };
  }

  it('generates a request id and sets it on the request and response when none is supplied', (done) => {
    const { request, response, context, next } = buildContext({});

    interceptor.intercept(context, next).subscribe(() => {
      expect(request.requestId).toEqual(expect.any(String));
      expect(request.requestId.length).toBeGreaterThan(0);
      expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', request.requestId);
      done();
    });
  });

  it('reuses an inbound x-request-id header instead of generating a new one', (done) => {
    const { request, response, context, next } = buildContext({ 'x-request-id': 'incoming-id-123' });

    interceptor.intercept(context, next).subscribe(() => {
      expect(request.requestId).toBe('incoming-id-123');
      expect(response.setHeader).toHaveBeenCalledWith('X-Request-Id', 'incoming-id-123');
      done();
    });
  });
});

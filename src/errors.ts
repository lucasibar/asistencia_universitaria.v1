import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
export function fail(code: string, status = 400): never { throw new HttpException({ code }, status); }
@Catch()
export class ApiErrors implements ExceptionFilter {
  private readonly logger = new Logger('API');
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const body = error.getResponse();
      const data = typeof body === 'object' ? body as Record<string, unknown> : {};
      response.status(error.getStatus()).json({ code: data.code ?? (error.getStatus() === 429 ? 'RATE_LIMITED' : 'REQUEST_REJECTED'), message: data.message });
    } else {
      // Do not log tokens, SQL values, authorization headers or student identities.
      this.logger.error('Unhandled request failure');
      response.status(500).json({ code: 'INTERNAL_ERROR' });
    }
  }
}

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** A business-rule violation: reported to the caller with a stable code, never a stack trace. */
export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number = HttpStatus.UNPROCESSABLE_ENTITY,
              public readonly details?: unknown) {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) { super('not_found', `${what} not found`, HttpStatus.NOT_FOUND); }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: unknown) { super('conflict', message, HttpStatus.CONFLICT, details); }
}

export class ForbiddenError extends DomainError {
  constructor(message: string) { super('forbidden', message, HttpStatus.FORBIDDEN); }
}

/** Global filter: consistent JSON errors; internal details are logged, never returned (SDD 26.5). */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');
  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof DomainError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message = typeof body === 'string' ? body : (body as { message?: unknown }).message ?? err.message;
      res.status(err.getStatus()).json({ error: 'request_error', message });
      return;
    }
    this.log.error(err instanceof Error ? err.stack ?? err.message : String(err));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'internal_error', message: 'An unexpected error occurred' });
  }
}

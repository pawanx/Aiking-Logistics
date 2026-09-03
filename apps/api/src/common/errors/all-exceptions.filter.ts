import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiErrorCode, type ApiErrorBody } from '@aiking/shared';
import type { Request, Response } from 'express';

import { TenantScopeMissingError } from '../tenant/tenant-context';

/**
 * Single exit point for every error, so the API only ever emits one error shape
 * (`ApiErrorBody`) and never leaks an internal message or stack to a client.
 *
 * Also the place where Prisma's numeric error codes become domain codes — a
 * unique-constraint violation that escapes a service is a 409, not a 500.
 */
@Injectable()
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const { status, code, message, details, logAsError } = this.translate(exception);

    const body: ApiErrorBody = {
      statusCode: status,
      code,
      message,
      details,
      path: request?.url ?? '',
      timestamp: new Date().toISOString(),
    };

    if (logAsError) {
      this.logger.error(
        `${request?.method ?? '?'} ${request?.url ?? '?'} → ${status} ${code}: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request?.method ?? '?'} ${request?.url ?? '?'} → ${status} ${code}: ${message}`);
    }

    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
    logAsError: boolean;
  } {
    // AppException and its subclasses already carry a code.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null && 'code' in payload) {
        const typed = payload as { code: ApiErrorCode; message: string; details?: Record<string, unknown> };
        return {
          status,
          code: typed.code,
          message: typed.message,
          details: typed.details,
          logAsError: status >= 500,
        };
      }

      // A framework exception (404 from the router, 400 from ValidationPipe).
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] })?.message ?? exception.message);

      return {
        status,
        code: this.codeForStatus(status),
        message: Array.isArray(message) ? message.join('; ') : message,
        details: Array.isArray((payload as { message?: string[] })?.message)
          ? { issues: (payload as { message: string[] }).message }
          : undefined,
        logAsError: status >= 500,
      };
    }

    // A tenant-scoped query ran with no context at all. Always a bug on our side.
    if (exception instanceof TenantScopeMissingError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ApiErrorCode.INTERNAL,
        message: 'Internal server error',
        logAsError: true,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.translatePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ApiErrorCode.VALIDATION_FAILED,
        message: 'The request could not be processed as submitted',
        logAsError: true,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ApiErrorCode.INTERNAL,
      message: 'Internal server error',
      logAsError: true,
    };
  }

  private translatePrisma(error: Prisma.PrismaClientKnownRequestError): {
    status: number;
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
    logAsError: boolean;
  } {
    const target = Array.isArray(error.meta?.target)
      ? (error.meta?.target as string[]).join(', ')
      : String(error.meta?.target ?? '');

    switch (error.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: ApiErrorCode.DUPLICATE_REQUEST,
          message: target ? `A record with this ${target} already exists` : 'This record already exists',
          details: target ? { fields: target } : undefined,
          logAsError: false,
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: ApiErrorCode.NOT_FOUND,
          message: 'The requested record was not found',
          logAsError: false,
        };
      case 'P2003':
        return {
          status: HttpStatus.BAD_REQUEST,
          code: ApiErrorCode.VALIDATION_FAILED,
          message: 'A referenced record does not exist',
          logAsError: false,
        };
      default:
        return {
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          code: ApiErrorCode.INTERNAL,
          message: 'Internal server error',
          logAsError: true,
        };
    }
  }

  private codeForStatus(status: number): ApiErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ApiErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ApiErrorCode.FORBIDDEN_ROLE;
      case HttpStatus.NOT_FOUND:
        return ApiErrorCode.NOT_FOUND;
      case HttpStatus.BAD_REQUEST:
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ApiErrorCode.VALIDATION_FAILED;
      case HttpStatus.CONFLICT:
        return ApiErrorCode.DUPLICATE_REQUEST;
      case HttpStatus.PAYMENT_REQUIRED:
        return ApiErrorCode.INSUFFICIENT_FUNDS;
      default:
        return status >= 500 ? ApiErrorCode.INTERNAL : ApiErrorCode.VALIDATION_FAILED;
    }
  }
}

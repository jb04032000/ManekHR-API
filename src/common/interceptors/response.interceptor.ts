import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiResponse } from '../types/api-response.type';

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ApiResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    return next.handle().pipe(
      map((res: unknown) => {
        // If it's already an ApiResponse (e.g. paginated result with meta), just return it
        if (
          typeof res === 'object' &&
          res !== null &&
          'success' in res &&
          'data' in res
        ) {
          return res as ApiResponse<T>;
        }

        return {
          success: true,
          data: res as T,
        };
      }),
    );
  }
}

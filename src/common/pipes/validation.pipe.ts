import {
  ValidationPipe as NestValidationPipe,
  ValidationError,
} from '@nestjs/common';

export class ValidationPipe extends NestValidationPipe {
  constructor() {
    super({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors: ValidationError[]) => {
        const formatErrors = (errors: ValidationError[]) => {
          return errors.flatMap((error) => {
            if (error.children && error.children.length > 0) {
              return formatErrors(error.children);
            }
            return Object.values(error.constraints || {});
          });
        };
        const messages = formatErrors(errors);
        return {
          success: false,
          error: {
            code: 400,
            message: messages,
            details: messages,
          },
        };
      },
    });
  }
}

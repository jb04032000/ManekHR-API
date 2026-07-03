import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * Cross-field validator: the decorated numeric field must be >= a sibling field
 * (e.g. `priceMax` >= `priceMin`). Returns valid when either value is
 * null/undefined, so it composes cleanly with `@IsOptional()`. Apply to the
 * MAX of a min/max range pair so an inverted range (max < min) is rejected.
 */
export function IsGteField(siblingProperty: string, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isGteField',
      target: object.constructor,
      propertyName,
      constraints: [siblingProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [sibling] = args.constraints as [string];
          const min = (args.object as Record<string, unknown>)[sibling];
          if (value == null || min == null) return true;
          return typeof value === 'number' && typeof min === 'number' && value >= min;
        },
        defaultMessage(args: ValidationArguments): string {
          const [sibling] = args.constraints as [string];
          return `${args.property} must be greater than or equal to ${sibling}`;
        },
      },
    });
  };
}

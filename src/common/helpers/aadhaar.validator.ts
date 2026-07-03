import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

// Verhoeff checksum — UIDAI Aadhaar spec
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function isValidAadhaar(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (!/^[0-9]{12}$/.test(value)) return false;
  if (value[0] === '0' || value[0] === '1') return false;
  let c = 0;
  const digits = value
    .split('')
    .reverse()
    .map((ch) => Number(ch));
  for (let i = 0; i < digits.length; i++) {
    c = D[c][P[i % 8][digits[i]]];
  }
  return c === 0;
}

export function IsAadhaar(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAadhaar',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === 'string' && isValidAadhaar(value);
        },
        defaultMessage(_args: ValidationArguments) {
          return 'Invalid Aadhaar number (must be 12 digits with valid Verhoeff checksum)';
        },
      },
    });
  };
}

/**
 * Quantity value-object — wraps a numeric quantity with decimal precision.
 * Used for item quantities in finance transactions.
 */
export class Quantity {
  constructor(
    private readonly raw: number,
    private readonly decimalPlaces: number = 2,
  ) {}

  static fromNumber(value: number, decimalPlaces = 2): Quantity {
    return new Quantity(value, decimalPlaces);
  }

  toNumber(): number {
    return parseFloat(this.raw.toFixed(this.decimalPlaces));
  }

  get value(): number {
    return this.toNumber();
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.raw + other.raw, this.decimalPlaces);
  }

  sub(other: Quantity): Quantity {
    return new Quantity(this.raw - other.raw, this.decimalPlaces);
  }

  mul(factor: number): Quantity {
    return new Quantity(this.raw * factor, this.decimalPlaces);
  }
}

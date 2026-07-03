/**
 * Money value-object — stores rupees as integer paise (×100).
 * All finance monetary fields use this at service layer.
 * MongoDB stores the raw integer via @Prop({ type: Number }).
 */
export class Money {
  private constructor(private readonly paise: number) {}

  static fromNumber(rupees: number): Money {
    return new Money(Math.round(rupees * 100));
  }

  static fromPaise(paise: number): Money {
    return new Money(Math.round(paise));
  }

  static zero(): Money {
    return new Money(0);
  }

  toNumber(): number {
    return this.paise / 100;
  }

  get value(): number {
    return this.paise;
  }

  add(other: Money): Money {
    return new Money(this.paise + other.paise);
  }

  sub(other: Money): Money {
    return new Money(this.paise - other.paise);
  }

  mul(factor: number): Money {
    return new Money(Math.round(this.paise * factor));
  }

  roundHalfUp(): Money {
    // Already stored as paise integer — no further rounding needed.
    return this;
  }

  isZero(): boolean {
    return this.paise === 0;
  }

  isNegative(): boolean {
    return this.paise < 0;
  }

  equals(other: Money): boolean {
    return this.paise === other.paise;
  }
}

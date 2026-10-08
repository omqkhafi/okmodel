/**
 * Methods the codecs call, for this repository's typecheck.
 *
 * The published declaration is the empty `namespace Temporal` in
 * `temporal.ts`. This file is not imported. A consumer's TypeScript Temporal
 * lib, or `temporal-polyfill`, supplies the same names. Shipping these
 * signatures conflicts with both (QA-L2).
 */

declare global {
  namespace Temporal {
    interface Instant {
      toString(options?: { readonly fractionalSecondDigits?: number }): string;
    }
    interface PlainDateTime {
      toString(options?: { readonly fractionalSecondDigits?: number }): string;
    }
    interface PlainDate {
      toString(): string;
      add(duration: { readonly days: number }): Temporal.PlainDate;
    }
    interface PlainTime {
      toString(options?: { readonly fractionalSecondDigits?: number }): string;
    }
    interface Duration {
      toString(): string;
    }
  }

  var Temporal: {
    readonly Instant: {
      from(item: string): Temporal.Instant;
    };
    readonly PlainDateTime: {
      from(item: string): Temporal.PlainDateTime;
    };
    readonly PlainDate: {
      from(item: string): Temporal.PlainDate;
    };
    readonly PlainTime: {
      from(item: string): Temporal.PlainTime;
    };
    readonly Duration: {
      from(item: string | Readonly<Record<string, number>>): Temporal.Duration;
    };
  };
}

export {};

/**
 * Typed raw SQL, written by okm raw sync.
 * A Postgres type with no codec is string, the text the driver returns.
 */
import "okmodel/pg";

declare module "okmodel/pg" {
  type jsonb<T> = T;
  type json<T> = T;
  interface RawStatements {
    "select area from tasks": {
      readonly params: readonly [];
      readonly row: { readonly area: string };
      readonly kind: "read";
    };
    "select labels from tasks where mood = any($1)": {
      readonly params: readonly [("open" | "closed")[]];
      readonly row: { readonly labels: ("open" | "closed")[] };
      readonly kind: "read";
    };
    "select payload, meta from tasks": {
      readonly params: readonly [];
      readonly row: { readonly payload: jsonb<unknown>; readonly meta: json<unknown> };
      readonly kind: "read";
    };
  }
}

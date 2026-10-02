# Editor check (P12)

Hover and autocomplete are unmeasured (D111, D120). This list is for a person to run in an editor. It was not run as part of the change that added it.

Open a TypeScript file in this repository, or a small project that imports `okmodel` and `okmodel/pg`.

1. Hover `Row<"tasks">` after `declare module "okmodel" { interface Register { readonly schema: typeof appSchema } }`. The hover should show the task fields (`id`, `title`, and the rest), not a builder type. Hidden fields are absent.
2. Type `Row<"` and accept a completion. The names should be the table names on the registered schema. `Insert<"` and `Update<"` should offer the same names.
3. Type `Row<"` and accept a completion for a reference target, then write `ownerId: t.uuid().references("users")`. The `references()` argument stays a `string` (a generic table-name argument cycles through `Register`). Autocomplete of table names is the `Row` / `Insert` / `Update` argument, not the `references()` argument.
4. Pass a table name that is not in `schema({ tables })`, then call `schema()`. The failure is OKM1020. The message names the missing table and the accepted names. This is a construction error, not a recursive type error.

`okm check` reporting a second `Register` is OKM1025 and is not part of this check.

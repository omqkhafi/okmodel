/**
 * Second table file. The foreign key is a name, so this file does not import users.
 */
/** Tasks table for the Register sample. Covers the generics suite. */
export declare const tasks: import("./table.js").Table<
  "tasks",
  import("./table.js").NamedColumns<
    "tasks",
    {
      readonly id: import("./column.js").ColumnBuilder<
        string,
        {
          readonly nullable: false;
          readonly hasDefault: false;
          readonly generated: false;
          readonly id: true;
          readonly hidden: false;
          readonly guarded: false;
        },
        undefined
      >;
      readonly ownerId: import("./column.js").ColumnBuilder<
        string,
        {
          readonly nullable: false;
          readonly hasDefault: false;
          readonly generated: false;
          readonly id: false;
          readonly hidden: false;
          readonly guarded: false;
        },
        "users"
      >;
      readonly title: import("./column.js").ColumnBuilder<
        string,
        {
          readonly nullable: false;
          readonly hasDefault: false;
          readonly generated: false;
          readonly id: false;
          readonly hidden: false;
          readonly guarded: false;
        },
        undefined
      >;
      readonly status: import("./column.js").ColumnBuilder<
        "active" | "done" | "draft",
        import("./column.js").FlagTrue<
          {
            readonly nullable: false;
            readonly hasDefault: false;
            readonly generated: false;
            readonly id: false;
            readonly hidden: false;
            readonly guarded: false;
          },
          "hasDefault"
        >,
        undefined
      >;
      readonly notes: import("./column.js").ColumnBuilder<
        string,
        import("./column.js").FlagTrue<
          {
            readonly nullable: false;
            readonly hasDefault: false;
            readonly generated: false;
            readonly id: false;
            readonly hidden: false;
            readonly guarded: false;
          },
          "nullable"
        >,
        undefined
      >;
      readonly meta: import("./column.js").ColumnBuilder<
        {
          readonly ok: boolean;
        },
        {
          readonly nullable: false;
          readonly hasDefault: false;
          readonly generated: false;
          readonly id: false;
          readonly hidden: false;
          readonly guarded: false;
        },
        undefined
      >;
      readonly tags: import("./column.js").ColumnBuilder<
        readonly string[],
        {
          readonly nullable: false;
          readonly hasDefault: false;
          readonly generated: false;
          readonly id: false;
          readonly hidden: false;
          readonly guarded: false;
        },
        undefined
      >;
      readonly rank: import("./column.js").ColumnBuilder<
        number,
        import("./column.js").WithGenerated<{
          readonly nullable: false;
          readonly hasDefault: false;
          readonly generated: false;
          readonly id: false;
          readonly hidden: false;
          readonly guarded: false;
        }>,
        undefined
      >;
      readonly secret: import("./column.js").ColumnBuilder<
        string,
        import("./column.js").FlagTrue<
          {
            readonly nullable: false;
            readonly hasDefault: false;
            readonly generated: false;
            readonly id: false;
            readonly hidden: false;
            readonly guarded: false;
          },
          "hidden"
        >,
        undefined
      >;
      readonly role: import("./column.js").ColumnBuilder<
        string,
        import("./column.js").FlagTrue<
          {
            readonly nullable: false;
            readonly hasDefault: false;
            readonly generated: false;
            readonly id: false;
            readonly hidden: false;
            readonly guarded: false;
          },
          "guarded"
        >,
        undefined
      >;
      readonly kind: import("./column.js").ColumnBuilder<
        "bug" | "feature",
        {
          readonly nullable: false;
          readonly hasDefault: false;
          readonly generated: false;
          readonly id: false;
          readonly hidden: false;
          readonly guarded: false;
        },
        undefined
      > & {
        readonly "~enum": "task_kind";
      };
    }
  >,
  readonly ["archivable"]
>;
declare module "@okmodel/spikes/types" {
  interface RegisteredTables {
    readonly tasks: typeof tasks;
  }
}

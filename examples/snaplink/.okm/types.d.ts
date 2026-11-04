/**
 * Row types emitted from the schema.
 * Mode: emitted.
 */

export interface Links {
  readonly id: string;
  readonly slug: string;
  readonly url: string;
  readonly createdAt: string;
}

export interface LinksInsert {
  readonly slug: string;
  readonly url: string;
  readonly createdAt?: string;
}

export interface LinksUpdate {
  readonly slug?: string;
  readonly url?: string;
  readonly createdAt?: string;
}

export interface Clicks {
  readonly id: string;
  readonly linkId: string;
  readonly clickedAt: string;
}

export interface ClicksInsert {
  readonly linkId: string;
  readonly clickedAt?: string;
}

export interface ClicksUpdate {
  readonly linkId?: string;
  readonly clickedAt?: string;
}

export interface Rows {
  readonly links: Links;
  readonly clicks: Clicks;
}

export interface Inserts {
  readonly links: LinksInsert;
  readonly clicks: ClicksInsert;
}

export interface Updates {
  readonly links: LinksUpdate;
  readonly clicks: ClicksUpdate;
}
import type { ColumnFlags, ReferenceOptions } from "okmodel/pg";

declare module "okmodel/pg" {
  interface ColumnBuilder<TValue, TFlags extends ColumnFlags> {
    references(
      table: "links" | "clicks",
      options?: ReferenceOptions,
    ): ColumnBuilder<TValue, TFlags>;
  }
}

export type TableName = "links" | "clicks";

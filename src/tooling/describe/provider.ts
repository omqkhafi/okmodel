/**
 * Chooses who describes a statement.
 *
 * The project driver is first when it can describe without executing and
 * returns parameter OIDs plus result fields. Otherwise one direct connection
 * speaks the extended protocol. Both paths refuse a known pooler unless
 * `allowPooler` is set. Neither path binds or executes the statement.
 */

import type { DescribeField, DescribeResult, DriverPool } from "../../contracts/driver.js";
import { assertDirectConnection } from "../migrate/policy.js";
import { connectDescribe, DescribeError, type DescribeOutcome } from "./protocol.js";

/** Input for {@link describeSql}. */
export type DescribeSqlInput = {
  /** One statement. */
  readonly text: string;
  /** Direct connection URL. The pooler guard reads it. */
  readonly url: string;
  /** Project pool. Used when `describe` is present. */
  readonly pool?: DriverPool;
  /** Overrides the pooler refusal. */
  readonly allowPooler?: boolean;
};

/**
 * Describes `text` without running it.
 *
 * @param input - Statement, URL, and optional project pool
 * @returns Parameter OIDs and result fields
 */
export async function describeSql(input: DescribeSqlInput): Promise<DescribeResult> {
  assertDirectConnection(input.url, input.allowPooler === true);
  if (input.pool?.describe !== undefined) return input.pool.describe(input.text);
  const client = await connectDescribe(input.url, { allowPooler: input.allowPooler === true });
  try {
    const outcome = await client.describe(input.text);
    if (outcome.code !== undefined)
      throw new DescribeError(outcome.code, outcome.message ?? outcome.code);
    return resultFromOutcome(outcome);
  } finally {
    client.close();
  }
}

/**
 * Converts a wire describe into the driver result.
 *
 * An error outcome still converts its columns. The caller decides whether to throw.
 *
 * @param outcome - Wire describe
 * @returns The driver shape
 */
export function resultFromOutcome(outcome: DescribeOutcome): DescribeResult {
  const fields: DescribeField[] = outcome.columns.map((column) => ({
    name: column.name,
    typeOid: column.typeOid,
    tableOid: column.tableOid,
    attnum: column.attnum,
  }));
  return {
    columns: fields.map((field) => field.name),
    parameterCount: outcome.parameterOids.length,
    parameters: outcome.parameterOids,
    fields,
  };
}

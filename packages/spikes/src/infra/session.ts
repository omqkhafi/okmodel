/**
 * Throwaway databases and SQLSTATE helpers for the infra spike.
 */

import { openPostgres, primaryUrl, withPostgres } from "@okmodel/harness";
import type { Sql } from "postgres";

import { quoteIdent } from "../catalog/sql.js";

/**
 * SQLSTATE from a driver error, or an empty string.
 *
 * @param error - A thrown value
 * @returns The five-character code when the driver set one
 */
export function sqlState(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  const code = error.code;
  return typeof code === "string" ? code : "";
}

/**
 * Message from a thrown value.
 *
 * @param error - A thrown value
 * @returns The message, or the value itself when it is not an error
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * `detail` from a driver error, when the driver set one.
 *
 * @param error - A thrown value
 * @returns The detail text, or an empty string
 */
export function errorDetail(error: unknown): string {
  if (typeof error !== "object" || error === null || !("detail" in error)) return "";
  const detail = error.detail;
  return typeof detail === "string" ? detail : "";
}

/**
 * Opens a new database, runs `fn`, and drops the database.
 *
 * Roles are cluster-wide, so `fn` must drop any role it created.
 *
 * @param fn - Receives a connection to the empty database
 */
export async function withThrowawayDatabase(fn: (sql: Sql) => Promise<void>): Promise<void> {
  const name = `d_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = openPostgres();
  try {
    await admin.unsafe(`create database ${quoteIdent(name)}`);
    const url = new URL(primaryUrl());
    url.pathname = `/${name}`;
    await withPostgres(fn, url.toString());
  } finally {
    await admin.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
    await admin.end({ timeout: 5 });
  }
}

/**
 * Opens two empty databases and drops both afterwards.
 *
 * @param fn - Receives a connection to each database
 */
export async function withTwoDatabases(
  fn: (left: Sql, right: Sql) => Promise<void>,
): Promise<void> {
  const admin = openPostgres();
  const leftName = `d_${crypto.randomUUID().replaceAll("-", "")}`;
  const rightName = `d_${crypto.randomUUID().replaceAll("-", "")}`;
  const urlFor = (name: string): string => {
    const url = new URL(primaryUrl());
    url.pathname = `/${name}`;
    return url.toString();
  };
  let left: Sql | undefined;
  let right: Sql | undefined;
  try {
    await admin.unsafe(`create database ${quoteIdent(leftName)}`);
    await admin.unsafe(`create database ${quoteIdent(rightName)}`);
    left = openPostgres(urlFor(leftName));
    right = openPostgres(urlFor(rightName));
    await fn(left, right);
  } finally {
    await left?.end({ timeout: 5 });
    await right?.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists ${quoteIdent(leftName)} with (force)`);
    await admin.unsafe(`drop database if exists ${quoteIdent(rightName)} with (force)`);
    await admin.end({ timeout: 5 });
  }
}

/**
 * Drops privileges and then the role. Missing roles are ignored.
 *
 * @param sql - Connection. `DROP OWNED` applies only in this database
 * @param name - Role name
 */
export async function dropRole(sql: Sql, name: string): Promise<void> {
  const quoted = quoteIdent(name);
  try {
    await sql.unsafe(`drop owned by ${quoted}`);
  } catch (error) {
    if (sqlState(error) !== "42704") throw error;
  }
  await sql.unsafe(`drop role if exists ${quoted}`);
}

/**
 * Network address columns. Values are canonical text.
 */

import { type ColumnBuilder, type PlainFlags, required } from "./column.js";
import { rejected } from "./misuse.js";

/**
 * IPv4 or IPv6 host, with an optional prefix.
 *
 * @returns An inet column
 */
export function inet(): ColumnBuilder<string, PlainFlags> {
  return network("inet", false);
}

/**
 * IPv4 or IPv6 network. A prefix is required.
 *
 * @returns A cidr column
 */
export function cidr(): ColumnBuilder<string, PlainFlags> {
  return network("cidr", true);
}

/**
 * 48-bit MAC address, lowercase.
 *
 * @returns A macaddr column
 */
export function macaddr(): ColumnBuilder<string, PlainFlags> {
  return mac(6, "macaddr");
}

/**
 * 64-bit MAC address, lowercase.
 *
 * @returns A macaddr8 column
 */
export function macaddr8(): ColumnBuilder<string, PlainFlags> {
  return mac(8, "macaddr8");
}

function network(
  baseType: "inet" | "cidr",
  prefixRequired: boolean,
): ColumnBuilder<string, PlainFlags> {
  return required({
    baseType,
    encode: (value) => encodeNetwork(value, baseType, prefixRequired),
    decode: (wire) => encodeNetwork(wire, baseType, prefixRequired),
    sqlForm: "quote",
  });
}

function mac(groups: 6 | 8, baseType: string): ColumnBuilder<string, PlainFlags> {
  return required({
    baseType,
    encode: (value) => encodeMac(value, groups, baseType),
    decode: (wire) => encodeMac(wire, groups, baseType),
    sqlForm: "quote",
  });
}

function encodeNetwork(value: string, role: string, prefixRequired: boolean): string {
  const text = value.toLowerCase();
  const slash = text.lastIndexOf("/");
  const host = slash === -1 ? text : text.slice(0, slash);
  const prefix = slash === -1 ? undefined : text.slice(slash + 1);
  if (prefixRequired && prefix === undefined) {
    rejected(`${role} ${value} needs a prefix length.`);
  }
  if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > 128)) {
    rejected(`${role} prefix ${prefix} is not a length.`);
  }
  if (host.includes(":")) {
    if (!/^[0-9a-f:]+$/.test(host) || host.length > 39) {
      rejected(`${role} ${value} is not an address.`);
    }
    return prefix === undefined ? host : `${host}/${prefix}`;
  }
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((octet) => !octetOk(octet))) {
    rejected(`${role} ${value} is not an address.`);
  }
  if (prefix !== undefined && Number(prefix) > 32) {
    rejected(`${role} prefix ${prefix} is not a length.`);
  }
  return prefix === undefined ? host : `${host}/${prefix}`;
}

function octetOk(octet: string): boolean {
  if (!/^\d{1,3}$/.test(octet)) {
    return false;
  }
  const value = Number(octet);
  return value <= 255 && octet === String(value);
}

function encodeMac(value: string, groups: number, role: string): string {
  const text = value.toLowerCase();
  const parts = text.split(":");
  if (parts.length !== groups || parts.some((part) => !/^[0-9a-f]{2}$/.test(part))) {
    rejected(`${role} ${value} is not a MAC address.`);
  }
  return text;
}

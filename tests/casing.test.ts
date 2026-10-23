import { describe, expect, test } from "bun:test";
import { caseName, namesFor } from "../src/dialects/pg/casing.js";
import { table, t } from "../src/dialects/pg/index.js";

/** key, snake, camel. */
const VECTORS: readonly (readonly [string, string, string])[] = [
  // The rules as decided.
  ["userID", "user_id", "userId"],
  ["getURLs", "get_urls", "getUrls"],
  ["HTMLParser", "html_parser", "htmlParser"],
  ["address2", "address2", "address2"],
  ["line1Text", "line1_text", "line1Text"],
  ["user_id", "user_id", "userId"],
  ["userId", "user_id", "userId"],
  // Plain words and single letters.
  ["id", "id", "id"],
  ["x", "x", "x"],
  ["X", "x", "x"],
  ["aB", "a_b", "aB"],
  ["aBC", "a_bc", "aBc"],
  ["a_b_c", "a_b_c", "aBC"],
  ["getX", "get_x", "getX"],
  ["xCoord", "x_coord", "xCoord"],
  // All caps and acronyms.
  ["ID", "id", "id"],
  ["URL", "url", "url"],
  ["ALLCAPS", "allcaps", "allcaps"],
  ["ALL_CAPS", "all_caps", "allCaps"],
  ["HTTPServer", "http_server", "httpServer"],
  ["getHTTPSUrl", "get_https_url", "getHttpsUrl"],
  ["ABCd", "ab_cd", "abCd"],
  // A plural s closes an acronym only when the word ends there.
  ["IDs", "ids", "ids"],
  ["userIDs", "user_ids", "userIds"],
  ["URLsList", "urls_list", "urlsList"],
  ["getURLs2", "get_urls2", "getUrls2"],
  ["getURLstring", "get_ur_lstring", "getUrLstring"],
  ["As", "as", "as"],
  ["getAs", "get_as", "getAs"],
  // Digits glue to the word before them.
  ["HTML5Parser", "html5_parser", "html5Parser"],
  ["html5_parser", "html5_parser", "html5Parser"],
  ["user2fa", "user2fa", "user2fa"],
  ["user_2fa", "user_2fa", "user2fa"],
  ["2fa", "2fa", "2fa"],
  ["2Fa", "2_fa", "2Fa"],
  ["A1B2", "a1_b2", "a1B2"],
  // Underscores: ends are kept, inner runs are one separator.
  ["_id", "_id", "_id"],
  ["id_", "id_", "id_"],
  ["_a_b_", "_a_b_", "_aB_"],
  ["__proto", "__proto", "__proto"],
  ["a__b", "a_b", "aB"],
  ["_", "_", "_"],
  ["__", "__", "__"],
  // Non-ASCII passes through and does not change case.
  ["naïveBayes", "naïve_bayes", "naïveBayes"],
  ["çaVa", "ça_va", "çaVa"],
  ["Ünï", "Ünï", "Ünï"],
  ["ÉcoleURL", "École_url", "ÉcoleUrl"],
  ["日本語Name", "日本語_name", "日本語Name"],
  ["emoji😀Id", "emoji😀_id", "emoji😀Id"],
  ["", "", ""],
];

describe("caseName golden vectors", () => {
  for (const [key, snake, camel] of VECTORS) {
    test(`${JSON.stringify(key)} -> snake ${JSON.stringify(snake)}, camel ${JSON.stringify(camel)}`, () => {
      expect(caseName("snake", key)).toBe(snake);
      expect(caseName("camel", key)).toBe(camel);
    });
  }

  test("snake is stable on its own output and camel reads it back", () => {
    for (const [key, snake, camel] of VECTORS) {
      expect(caseName("snake", snake)).toBe(snake);
      expect(caseName("camel", snake)).toBe(caseName("camel", key));
      if (key !== "a_b_c") expect(caseName("camel", camel)).toBe(camel);
    }
  });

  test("camel cannot read two single-letter words back: aBC is a and BC", () => {
    expect(caseName("camel", "a_b_c")).toBe("aBC");
    expect(caseName("camel", "aBC")).toBe("aBc");
  });

  test("snake output has no ASCII capital", () => {
    for (const [key] of VECTORS) expect(caseName("snake", key)).not.toMatch(/[A-Z]/);
  });
});

describe("namesFor", () => {
  const tasks = table("userTasks", {
    userID: t.text().primaryKey(),
    kept: t.text().sqlName("Kept"),
  });
  const named = table("userNotes", { id: t.text().primaryKey() }, { sqlName: "NOTES" });

  test("omitted casing is the key, verbatim", () => {
    const names = namesFor(undefined);
    expect(names.casing).toBeUndefined();
    expect(names.name("userID")).toBe("userID");
    expect(names.table(tasks)).toBe("userTasks");
    expect(names.column(tasks, "userID")).toBe("userID");
  });

  test("sqlName wins over the casing", () => {
    for (const casing of ["snake", "camel"] as const) {
      const names = namesFor(casing);
      expect(names.column(tasks, "kept")).toBe("Kept");
      expect(names.table(named)).toBe("NOTES");
    }
  });

  test("snake and camel spell tables and columns", () => {
    expect(namesFor("snake").table(tasks)).toBe("user_tasks");
    expect(namesFor("snake").column(tasks, "userID")).toBe("user_id");
    expect(namesFor("camel").table(tasks)).toBe("userTasks");
    expect(namesFor("camel").column(tasks, "userID")).toBe("userId");
  });
});

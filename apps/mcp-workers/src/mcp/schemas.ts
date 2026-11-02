import { z } from "zod";

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD format");
export const limitField = z.number().int().min(1).max(200).nullish().describe("Maximum results (1-200).");
export const cursorField = z.string().max(200).nullish().describe("Opaque pagination cursor from a previous result's next_cursor.");
export const categoryField = z
  .string().max(80).nullish()
  .describe("Category: a normalized value (DAILY, SUPPLEMENTARY, LAWAZIMA, REGULAR_HEARING, NOTICE) or the exact label published by the Court.");
export const sideField = z.enum(["PETITIONER", "RESPONDENT", "APPELLANT", "OTHER", "UNKNOWN"]).nullish().describe("Side as printed in the list's column headings.");
/** Court numbers can be a single digit ("3"), so court/bench queries only require 1 character. */
export const courtQuery = z.string().trim().min(1, "court_query must not be empty").max(100, "court_query is too long");
export const textQuery = (what: string) => z.string().trim().min(2, `${what} must be at least 2 characters`).max(200, `${what} is too long`);

/** Common structured result envelope for list-style tools (spec 8.4). Extra keys are allowed. */
export const listEnvelope = {
  success: z.boolean(),
  query: z.record(z.string(), z.unknown()).optional(),
  results: z.array(z.unknown()),
  total: z.number(),
  limit: z.number(),
  next_cursor: z.string().nullable(),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
};

export const plainEnvelope = {
  success: z.boolean(),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
};

export const DISCLAIMER =
  "Derived from the Gauhati High Court's published cause lists. The official PDF is the source of truth. A listing is not proof that a matter was heard, disposed of or ordered; this is not legal advice.";

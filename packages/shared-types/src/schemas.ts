import { z } from "zod";

export const CATEGORIES = ["DAILY", "SUPPLEMENTARY", "LAWAZIMA", "REGULAR_HEARING", "NOTICE"] as const;
export type CategoryNormalized = (typeof CATEGORIES)[number];

/** Categories whose PDFs use the tabular case-list layout and are parsed into entries. */
export const ENTRY_PARSED_CATEGORIES: readonly CategoryNormalized[] = [
  "DAILY",
  "SUPPLEMENTARY",
  "LAWAZIMA",
  "REGULAR_HEARING",
];

export const EXTRACTION_STATUSES = [
  "DISCOVERED",
  "DOWNLOADED",
  "PENDING_PARSE",
  "EXTRACTED",
  "PARTIALLY_EXTRACTED",
  "OCR_REQUIRED",
  "REVIEW_REQUIRED",
  "FAILED",
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const VALIDATION_STATUSES = ["VALIDATED", "NEEDS_REVIEW", "UNPARSED"] as const;
export const EXTRACTION_METHODS = ["TEXT", "OCR", "LLM_ASSISTED"] as const;
export const PARTY_SIDES = ["PETITIONER", "RESPONDENT", "APPELLANT", "RESPONDENT_SIDE", "OTHER", "UNKNOWN"] as const;
export const ADVOCATE_SIDES = ["PETITIONER", "RESPONDENT", "APPELLANT", "OTHER", "UNKNOWN"] as const;

export const benchSchema = z.object({
  court_label_raw: z.string().max(500).nullable(),
  bench_label_raw: z.string().max(500).nullable(),
  judges: z.array(z.string().max(300)).max(20).default([]),
  notes: z.array(z.string().max(500)).max(20).default([]),
  sitting_time_raw: z.string().max(200).nullable().default(null),
});
export type BenchPayload = z.infer<typeof benchSchema>;

const personSchema = z.object({
  name_raw: z.string().min(1).max(500),
  side: z.string(), // validated against the enum per table in the service layer
  sequence: z.number().int().nonnegative(),
});

export const entrySchema = z.object({
  entry_index: z.number().int().nonnegative(),
  bench: benchSchema.nullable(),
  serial_number: z.string().max(40).nullable(),
  item_number: z.string().max(40).nullable().default(null),
  case_number_raw: z.string().max(300).nullable(),
  listing_note_raw: z.string().max(2000).nullable().default(null),
  section_heading_raw: z.string().max(500).nullable().default(null),
  connected_cases: z.array(z.string().max(300)).max(50).default([]),
  page_start: z.number().int().positive(),
  page_end: z.number().int().positive(),
  raw_text: z.string().min(1).max(20000),
  extraction_method: z.enum(EXTRACTION_METHODS),
  extraction_confidence: z.number().min(0).max(1).nullable(),
  validation_status: z.enum(VALIDATION_STATUSES),
  validation_flags: z.array(z.string().max(100)).max(30).default([]),
  parties: z.array(personSchema).max(60).default([]),
  advocates: z.array(personSchema).max(120).default([]),
});
export type EntryPayload = z.infer<typeof entrySchema>;

export const pageSchema = z.object({
  page_number: z.number().int().positive(),
  text_content: z.string().max(200000).nullable(),
  extraction_method: z.enum(EXTRACTION_METHODS),
  ocr_confidence: z.number().min(0).max(1).nullable().default(null),
  page_status: z.enum(["OK", "EMPTY", "OCR_USED", "OCR_FAILED", "FAILED"]),
});
export type PagePayload = z.infer<typeof pageSchema>;

/**
 * Parser -> Worker callback. A parse is delivered as: one `begin`, N `chunk`s, one `complete`.
 * Every phase is idempotent for a given (version, parser_version): `begin` clears prior derived rows.
 */
export const parseResultSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("begin"),
    parser_version: z.string().min(1).max(100),
    page_count: z.number().int().nonnegative(),
  }),
  z.object({
    phase: z.literal("chunk"),
    parser_version: z.string().min(1).max(100),
    pages: z.array(pageSchema).max(200).default([]),
    entries: z.array(entrySchema).max(150).default([]),
  }),
  z.object({
    phase: z.literal("complete"),
    parser_version: z.string().min(1).max(100),
    extraction_status: z.enum(EXTRACTION_STATUSES),
    metadata: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    phase: z.literal("failed"),
    parser_version: z.string().min(1).max(100),
    error_code: z.string().max(100),
    error_message: z.string().max(1000),
  }),
]);
export type ParseResultPayload = z.infer<typeof parseResultSchema>;

/** Queue message contract (spec 6.4). */
export type IngestionMessage =
  | { type: "DOWNLOAD_AND_STORE"; documentId: string; force?: boolean }
  | { type: "PARSE_DOCUMENT_VERSION"; documentVersionId: string }
  | { type: "RETRY_DOCUMENT"; documentVersionId: string; reason: string };

export const ingestionMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("DOWNLOAD_AND_STORE"), documentId: z.string().min(1), force: z.boolean().optional() }),
  z.object({ type: z.literal("PARSE_DOCUMENT_VERSION"), documentVersionId: z.string().min(1) }),
  z.object({ type: z.literal("RETRY_DOCUMENT"), documentVersionId: z.string().min(1), reason: z.string().max(500) }),
]);

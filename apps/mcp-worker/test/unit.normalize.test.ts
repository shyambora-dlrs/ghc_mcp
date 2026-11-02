import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCaseNumber, normalizeCourtNumber, normalizeName } from "@ghc/shared-types";

const vectors = JSON.parse(readFileSync(join(import.meta.dirname, "../../../packages/shared-types/test-vectors/normalization.json"), "utf8"));

describe("case number normalization (shared vectors, mirrored in Python)", () => {
  for (const v of vectors.case_numbers) {
    it(`${JSON.stringify(v.input)} -> ${v.normalized}`, () => {
      const n = normalizeCaseNumber(v.input);
      expect(n?.normalized ?? null).toBe(v.normalized);
      expect(n?.key ?? null).toBe(v.key);
    });
  }
  it("flags implausible years but does not discard them", () => {
    const n = normalizeCaseNumber("WP(C)/5/3999");
    expect(n?.yearPlausible).toBe(false);
    expect(n?.normalized).toBe("WP(C)/5/3999");
  });
  it("never invents a number for non-case text", () => {
    expect(normalizeCaseNumber("FIXED, IN REVIEW.PET./55/2021")).toBeNull();
    expect(normalizeCaseNumber("CONNECTED WITH ITEM NO. 60")).toBeNull();
  });
});

describe("name normalization", () => {
  for (const v of vectors.names) it(JSON.stringify(v.input), () => expect(normalizeName(v.input)).toBe(v.normalized));
  it("does not merge different spellings", () => {
    expect(normalizeName("MD. RAHMAN")).not.toBe(normalizeName("MOHD RAHMAN"));
  });
});

describe("court numbers", () => {
  it("extracts the number", () => {
    expect(normalizeCourtNumber("COURT NO: 115")).toBe("115");
    expect(normalizeCourtNumber("Court No. 3")).toBe("3");
    expect(normalizeCourtNumber("SPECIAL DIVISION BENCH")).toBeNull();
  });
});

import type { CategoryNormalized } from "@ghc/shared-types";
import type { DateParseStatus } from "./dates";

export interface DiscoveredCauseListDocument {
  sourceKey: string;
  title: string | null;
  categoryLabelRaw: string | null;
  categoryNormalized: CategoryNormalized | null;
  listingDate: string | null;
  listingDateRaw: string | null;
  dateParseStatus: DateParseStatus;
  sourceUrl: string;
  canonicalUrl: string;
  finalUrl?: string | null;
  sourceFilename?: string | null;
  courtOrEstablishmentLabel?: string | null;
  publicationLabel?: string | null;
  discoveredAt: string;
  discoveryMetadata: Record<string, unknown>;
}

export interface ParsedSourcePage {
  documents: DiscoveredCauseListDocument[];
  columns: string[];
  warnings: string[];
}

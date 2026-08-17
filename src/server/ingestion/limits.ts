/**
 * MVP bulk-ingestion bounds — see docs/data-ingestion.md#limits. Chosen to
 * comfortably cover a real small-B2B customer/invoice book in one file
 * while keeping a single import request's work (and memory footprint)
 * bounded and predictable; not configurable per-org in this phase — a
 * genuinely larger import is a background-job problem this phase
 * explicitly does not build (see the brief's "do not over-engineer" and
 * "no background-job system" constraints).
 */
export const MAX_IMPORT_ROWS = 2000;

/** 5 MB comfortably fits 2000 rows of the fields this phase imports, with headroom. */
export const MAX_IMPORT_FILE_SIZE_BYTES = 5 * 1024 * 1024;

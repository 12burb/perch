/**
 * The error wire shape (spec §7.8): { error: { code, message, details }, request_id } with the matching
 * HTTP status. Shared by the api (PerchError → response) and the generated client.
 */
import { z } from "zod";

export const PERCH_ERROR_STATUS = {
  not_found: 404,
  forbidden: 403,
  validation: 422,
  conflict: 409,
  rate_limited: 429,
  budget_exceeded: 402,
  policy_violation: 451,
  upstream_failed: 502,
  internal: 500,
} as const;

export type PerchErrorCode = keyof typeof PERCH_ERROR_STATUS;
export const PERCH_ERROR_CODES = Object.keys(PERCH_ERROR_STATUS) as PerchErrorCode[];
export const perchErrorCodeSchema = z.enum(
  PERCH_ERROR_CODES as [PerchErrorCode, ...PerchErrorCode[]],
);

export const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: perchErrorCodeSchema,
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    request_id: z.string(),
  })
  .strict();
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

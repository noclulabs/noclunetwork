import { z } from "zod";

// The platform registry: the canonical, app-layer source of valid platforms,
// per registry-as-canonical (no Postgres enum, no metadata table). The database
// stores platform as free-form text; this registry is the integrity boundary,
// validating the platform field on every route input. Adding a platform later is
// a one-line change to PLATFORMS.
export const PLATFORMS = ["discord"] as const;

export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS);

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

import { z } from "zod";

// The libpq compatibility suffix the production DATABASE_URL must carry. Without
// it, node-pg attempts sslmode=verify-full and fails against DigitalOcean's
// self-signed cert with SELF_SIGNED_CERT_IN_CHAIN. See .env.example.
const LIBPQ_COMPAT_SUFFIX = "uselibpqcompat=true";

// A boolean read from an environment string. Unset uses the default; "true" is
// true and "false" is false; anything else fails validation loud (fail closed for
// a flag that governs a production behavior). The default applies before the
// transform, so an unset flag becomes its boolean default.
const envBoolean = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((value) => value === "true");

// Environment configuration, validated once on first access with a clear
// fail-fast message. DATABASE_URL, REDIS_URL, and SERVICE_TOKEN are required.
// The noclulabs.com channel credentials are reserved (declared, documented, not
// required) until the bridge phase, when the verify-sync poller becomes the first
// real consumer. They become required (the refine below) only when the poller is
// enabled.
const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    CORS_ORIGIN: z.string().default("*"),

    DATABASE_URL: z.string({ error: "DATABASE_URL is required" }).min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string({ error: "REDIS_URL is required" }).min(1, "REDIS_URL is required"),
    SERVICE_TOKEN: z.string({ error: "SERVICE_TOKEN is required" }).min(1, "SERVICE_TOKEN is required"),

    NOCLULABS_BASE_URL: z.string().url().optional(),
    NOCLULABS_SERVICE_TOKEN: z.string().optional(),
    // The outbound request timeout for every call to noclulabs.com.
    NOCLULABS_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

    // The inbound verify-sync poller (the bridge verify capability). It is inert
    // by default: with VERIFY_SYNC_ENABLED false the scheduler plugin starts no
    // timers and touches neither the database nor the network.
    VERIFY_SYNC_ENABLED: envBoolean("false"),
    // The fast-path incremental poll cadence.
    VERIFY_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
    // The full re-scan cadence (the gap-closure sweep, slower than the fast path).
    VERIFY_SYNC_RESCAN_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
    // The page size requested from surface B; the server clamps to its own max (500).
    VERIFY_SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(200),
  })
  // In production the connection to DigitalOcean managed Postgres requires the
  // libpq compatibility suffix. Enforce it here so a misconfigured deploy fails
  // fast at startup rather than on the first query. Non-production environments
  // (local Postgres, CI) do not need it.
  .refine(
    (config) =>
      config.NODE_ENV !== "production" || config.DATABASE_URL.includes(LIBPQ_COMPAT_SUFFIX),
    {
      path: ["DATABASE_URL"],
      message: `production DATABASE_URL must include the libpq compatibility suffix (${LIBPQ_COMPAT_SUFFIX}); the production Postgres connection requires it (see .env.example)`,
    },
  )
  // The verify-sync poller calls noclulabs.com, so enabling it without the base
  // URL and service token is a misconfiguration. Fail fast at config load rather
  // than letting every cycle error at runtime. While the flag is false the URL and
  // token stay optional and the poller stays inert.
  .refine(
    (config) =>
      !config.VERIFY_SYNC_ENABLED ||
      ((config.NOCLULABS_BASE_URL?.length ?? 0) > 0 &&
        (config.NOCLULABS_SERVICE_TOKEN?.length ?? 0) > 0),
    {
      path: ["VERIFY_SYNC_ENABLED"],
      message:
        "VERIFY_SYNC_ENABLED is true but NOCLULABS_BASE_URL or NOCLULABS_SERVICE_TOKEN is missing; the poller needs both to call noclulabs.com",
    },
  );

export type Config = z.infer<typeof configSchema>;

let cached: Config | undefined;

function loadConfig(): Config {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

// Lazily evaluated so importing a module that needs config has no side effects;
// the first call validates and caches. The startup path calls this early, which
// is the fail-fast point.
export function getConfig(): Config {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

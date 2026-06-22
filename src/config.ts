import { z } from "zod";

// The libpq compatibility suffix the production DATABASE_URL must carry. Without
// it, node-pg attempts sslmode=verify-full and fails against DigitalOcean's
// self-signed cert with SELF_SIGNED_CERT_IN_CHAIN. See .env.example.
const LIBPQ_COMPAT_SUFFIX = "uselibpqcompat=true";

// Environment configuration, validated once on first access with a clear
// fail-fast message. DATABASE_URL, REDIS_URL, and SERVICE_TOKEN are required.
// The noclulabs.com channel credentials are reserved (declared, documented, not
// required) and are used from the bridge phase.
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

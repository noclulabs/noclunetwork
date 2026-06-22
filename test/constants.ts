// Shared test environment defaults. vitest.config reads process.env first, so the
// shell or CI can override DATABASE_URL and REDIS_URL; these are the local
// fallbacks. They point at docker-compose.dev (host port 5433) and a
// noclunetwork_test database that the global setup creates if it is missing.
// SERVICE_TOKEN is fixed so the service-auth tests assert against a known value.
export const TEST_DATABASE_URL =
  "postgres://noclu:noclu@localhost:5433/noclunetwork_test?uselibpqcompat=true";
export const TEST_REDIS_URL = "redis://localhost:6379";
export const TEST_SERVICE_TOKEN = "test-service-token";

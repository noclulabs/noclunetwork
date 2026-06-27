import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { getConfig } from "@/config.js";
import { registerErrorHandler } from "@/plugins/error-handler.js";
import { registerServiceAuth } from "@/plugins/service-auth.js";
import { registerSwagger } from "@/plugins/swagger.js";
import { registerVerifySync } from "@/plugins/verify-sync.js";
import { registerEmitReconcile } from "@/plugins/emit-reconcile.js";
import { registerHealthRoute } from "@/routes/health.js";
import { registerParticipantRoutes } from "@/routes/participants.js";
import { registerCommunityRoutes } from "@/routes/communities.js";
import { registerMembershipRoutes } from "@/routes/memberships.js";
import { registerEngagementRoutes } from "@/routes/engagement.js";
import { registerModerationRoutes } from "@/routes/moderation.js";
import { registerSummonRoutes } from "@/routes/summon.js";
import { closeDb } from "@/lib/db/index.js";
import { closeRedis } from "@/lib/redis/index.js";

function buildLoggerOptions(
  nodeEnv: string,
  level: string,
): FastifyServerOptions["logger"] {
  if (nodeEnv === "test") {
    return false;
  }
  if (nodeEnv === "production") {
    return { level };
  }
  return {
    level,
    transport: {
      target: "pino-pretty",
      options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
    },
  };
}

// The app factory: registers plugins, then routes, and returns the instance
// without listening. Tests import this and use app.inject().
export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig();

  const app = Fastify({
    logger: buildLoggerOptions(config.NODE_ENV, config.LOG_LEVEL),
  });

  await app.register(cors, {
    origin:
      config.CORS_ORIGIN === "*"
        ? true
        : config.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
  });
  // A global limiter guards any future public-facing route. The only clients
  // today are trusted service-token bots, so the liveness probe and the resolve
  // routes opt out per route (config.rateLimit false); see their definitions.
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });

  // Swagger hooks onRoute, so it registers before any route is added.
  await registerSwagger(app);
  registerErrorHandler(app);
  registerServiceAuth(app);

  registerHealthRoute(app);

  // The bot-facing domain API. Versioned so noCluBot's generated client targets a
  // stable prefix; infra endpoints like /health stay at the root.
  await app.register(
    async (api) => {
      registerParticipantRoutes(api);
      registerCommunityRoutes(api);
      registerMembershipRoutes(api);
      registerEngagementRoutes(api);
      registerModerationRoutes(api);
      registerSummonRoutes(api);
    },
    { prefix: "/api/v1" },
  );

  // The inbound verify-sync poller. Always registered so enabling is a single
  // config flip, but inert unless VERIFY_SYNC_ENABLED is true (it self-gates and
  // starts no timers when disabled, so the test environment never starts it).
  registerVerifySync(app);

  // The outbound emit reconcile backstop. Always registered, but inert unless both
  // EMIT_SYNC_ENABLED and EMIT_RECONCILE_ENABLED are true (it self-gates and starts
  // no timer when disabled, so the test environment never starts it).
  registerEmitReconcile(app);

  return app;
}

// The startup path: build, listen, and wire graceful shutdown. Kept separate
// from the factory so importing the factory never starts a server.
export async function start(): Promise<void> {
  const app = await buildApp();
  const config = getConfig();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await closeRedis();
      await closeDb();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (err) {
    app.log.error({ err }, "failed to start");
    process.exit(1);
  }
}

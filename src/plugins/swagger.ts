import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

interface PackageManifest {
  version: string;
}

function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
  return manifest.version;
}

// The OpenAPI spec is the contract noCluBot generates its typed client from, so
// route schemas must be accurate. The spec is served at /openapi.json and the
// browsable UI at /docs.
export async function registerSwagger(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "noCluNetwork Core API",
        description:
          "The cross-platform community-engagement engine and the bridge between platform bots and noCluID.",
        version: readVersion(),
      },
      components: {
        securitySchemes: {
          serviceToken: {
            type: "apiKey",
            in: "header",
            name: "X-Service-Token",
          },
        },
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
  });

  app.get("/openapi.json", { schema: { hide: true } }, () => app.swagger());
}

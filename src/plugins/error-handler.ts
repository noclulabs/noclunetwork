import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fail } from "@/types/envelope.js";

// A typed application error. Routes and services throw this; the error handler
// renders it into the response envelope.
export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function convertBigInts(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map(convertBigInts);
  }
  // Recurse into plain objects only. Class instances (Date, Buffer, and the like)
  // are returned intact so the serializer can handle them; recursing with
  // Object.entries would flatten a Date to {} and break date-time serialization.
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = convertBigInts(entry);
    }
    return out;
  }
  return value;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .status(404)
      .send(fail("NOT_FOUND", `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler((error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send(fail(error.code, error.message));
      return;
    }

    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = error.code ?? (statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR");
    // Do not leak internal error detail on a 500.
    const message = statusCode >= 500 ? "Internal server error" : error.message;

    if (statusCode >= 500) {
      request.log.error({ err: error }, "request failed");
    }

    void reply.status(statusCode).send(fail(code, message));
  });

  // Convert any BigInt to Number so JSON serialization does not throw.
  app.addHook("preSerialization", async (_request, _reply, payload) => convertBigInts(payload));
}

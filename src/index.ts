import { start } from "@/server.js";

// Runtime entry point. The app factory and the listen call live in server.ts;
// this invokes startup and exits cleanly with the message on a startup failure
// (for example invalid environment configuration), rather than an unhandled
// rejection trace.
void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});

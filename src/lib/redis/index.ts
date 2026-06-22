import { Redis } from "ioredis";
import { getConfig } from "@/config.js";

// One Redis namespace for the whole application: every key is prefixed ncn:.
// This is an architectural invariant; no other prefix appears anywhere.
const KEY_PREFIX = "ncn:";

let client: Redis | undefined;

// Lazily constructed with lazyConnect so importing has no side effects and the
// app boots without Redis up at this phase. The connection opens on first use.
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(getConfig().REDIS_URL, {
      keyPrefix: KEY_PREFIX,
      lazyConnect: true,
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}

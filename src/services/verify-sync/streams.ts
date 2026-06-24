import type { Platform } from "@/lib/registry/platforms.js";

// The verify-sync streams. A stream pairs a provider (a registered platform) on
// surface B with the watermark key that tracks how far the poller has consumed
// it. The watermark is keyed by the stream string, so adding another platform
// later is a new entry here with no schema change (sync_watermarks is keyed by
// stream, not by a fixed column per platform).

// The provider value passed to surface B and mapped onto our claim tuple. It is
// the discord entry of the platform registry; kept as a typed Platform so a
// rename of the registry value is caught at compile time.
export const DISCORD_PROVIDER: Platform = "discord";

// The watermark key for the Discord verified-connections stream. Namespaced by
// source (noclulabs) and kind (verified) so other streams slot in beside it.
export const DISCORD_VERIFIED_STREAM = "noclulabs:verified:discord";

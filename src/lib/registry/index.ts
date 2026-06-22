// Registry-as-canonical.
//
// The TypeScript registry is the sole source of truth for the things it owns
// (the platform set, and later signal types and their weights, qualifier
// definitions, and similar). There is no DB metadata table and no foreign key
// onto registry ids; integrity is enforced at the application layer, so there is
// nothing to seed. This mirrors noclulabs.com.
//
// The platform registry is the first entry, the moderation action registry the
// second. The signal-type registry arrives with the bridge phase.
export * from "./platforms.js";
export * from "./moderation-actions.js";

// Registry-as-canonical.
//
// The TypeScript registry is the sole source of truth for the things it owns
// (signal types and their weights, qualifier definitions, and similar). There is
// no DB metadata table and no foreign key onto registry ids; integrity is
// enforced at the application layer, so there is nothing to seed. This mirrors
// noclulabs.com.
//
// The first registry (signal types) arrives with the bridge phase. No entries
// yet.
export {};

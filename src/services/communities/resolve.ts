import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/index.js";
import { isUniqueViolation, requireRow } from "@/lib/db/helpers.js";
import { communities, communityPlatforms } from "@/lib/db/schema/index.js";
import type { Platform } from "@/lib/registry/platforms.js";

export interface ResolveCommunityInput {
  platform: Platform;
  platformGroupId: string;
  name?: string;
}

export interface ResolvedCommunity {
  community: {
    id: string;
    name: string;
    createdAt: Date;
  };
  communityPlatform: {
    id: string;
    platform: string;
    platformGroupId: string;
  };
  created: boolean;
}

type Db = ReturnType<typeof getDb>;

interface CommunityWithPlatform {
  community: typeof communities.$inferSelect;
  communityPlatform: typeof communityPlatforms.$inferSelect;
}

// A placeholder display name when the caller did not supply one. The community
// can be renamed later; the platform group id keeps it unambiguous in the meantime.
function placeholderName(platform: string, platformGroupId: string): string {
  return `${platform} community ${platformGroupId}`;
}

async function findCommunityPlatform(
  db: Db,
  platform: string,
  platformGroupId: string,
): Promise<CommunityWithPlatform | undefined> {
  const rows = await db
    .select({ community: communities, communityPlatform: communityPlatforms })
    .from(communityPlatforms)
    .innerJoin(communities, eq(communities.id, communityPlatforms.communityId))
    .where(
      and(
        eq(communityPlatforms.platform, platform),
        eq(communityPlatforms.platformGroupId, platformGroupId),
      ),
    )
    .limit(1);
  return rows[0];
}

function shape(found: CommunityWithPlatform, created: boolean): ResolvedCommunity {
  return {
    community: {
      id: found.community.id,
      name: found.community.name,
      createdAt: found.community.createdAt,
    },
    communityPlatform: {
      id: found.communityPlatform.id,
      platform: found.communityPlatform.platform,
      platformGroupId: found.communityPlatform.platformGroupId,
    },
    created,
  };
}

// Resolve-or-create a community from a platform group id, idempotent on
// (platform, platform_group_id). An existing mapping returns its community; a
// new one creates a community (the given name, or a placeholder) plus its
// community_platform mapping in one transaction. Race-safe in the same way as
// resolveParticipant: a lost unique-key race rolls back and re-resolves.
export async function resolveCommunity(
  input: ResolveCommunityInput,
): Promise<ResolvedCommunity> {
  const db = getDb();
  const { platform, platformGroupId, name } = input;

  const existing = await findCommunityPlatform(db, platform, platformGroupId);
  if (existing) {
    return shape(existing, false);
  }

  try {
    const created = await db.transaction(async (tx) => {
      const insertedCommunity = requireRow(
        await tx
          .insert(communities)
          .values({ name: name ?? placeholderName(platform, platformGroupId) })
          .returning(),
        "insert communities",
      );
      const insertedPlatform = requireRow(
        await tx
          .insert(communityPlatforms)
          .values({
            communityId: insertedCommunity.id,
            platform,
            platformGroupId,
          })
          .returning(),
        "insert community_platforms",
      );
      return { community: insertedCommunity, communityPlatform: insertedPlatform };
    });
    return shape(created, true);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await findCommunityPlatform(db, platform, platformGroupId);
      if (raced) {
        return shape(raced, false);
      }
    }
    throw error;
  }
}

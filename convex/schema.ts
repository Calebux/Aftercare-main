import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // One saved workspace per session. `data` is encrypted by the Aftercare server; Convex never has the key.
  workspaces: defineTable({ session: v.string(), data: v.string(), updatedAt: v.number() }).index('by_session', ['session']),
});

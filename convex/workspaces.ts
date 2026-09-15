import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { mutation, query, type QueryCtx } from './_generated/server';

/**
 * Convex functions are public, so each one first checks the token only the Aftercare server holds.
 * Workspaces arrive encrypted, and the key stays on the server.
 */
function authorize(token: string) {
  const expected = process.env.AFTERCARE_CONVEX_TOKEN ?? '';
  // Every character is compared, so timing does not reveal how much of a guess matched.
  let mismatch = expected.length < 32 || token.length !== expected.length ? 1 : 0;
  for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch) throw new Error('Unauthorized');
}

const find = (ctx: QueryCtx, session: string) =>
  ctx.db.query('workspaces').withIndex('by_session', q => q.eq('session', session)).unique();

export const list = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { token, paginationOpts }) => {
    authorize(token);
    return await ctx.db.query('workspaces').paginate(paginationOpts);
  },
});

export const save = mutation({
  args: { token: v.string(), session: v.string(), data: v.string() },
  handler: async (ctx, { token, session, data }) => {
    authorize(token);
    const existing = await find(ctx, session);
    if (existing) await ctx.db.patch('workspaces', existing._id, { data, updatedAt: Date.now() });
    else await ctx.db.insert('workspaces', { session, data, updatedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { token: v.string(), session: v.string() },
  handler: async (ctx, { token, session }) => {
    authorize(token);
    const existing = await find(ctx, session);
    if (existing) await ctx.db.delete('workspaces', existing._id);
  },
});

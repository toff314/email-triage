import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { listContacts, upsertContacts } from "./queries/contacts";

export const contactRouter = createRouter({
  list: authedQuery.query(({ ctx }) => listContacts(ctx.user.id)),

  /** 手动添加（写信时新地址也可入册） */
  add: authedQuery
    .input(z.object({ email: z.string().email(), name: z.string().max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      await upsertContacts(ctx.user.id, [input]);
      return { ok: true };
    }),
});

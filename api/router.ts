import { authRouter } from "./auth-router";
import { accountRouter } from "./account-router";
import { ruleRouter } from "./rule-router";
import { mailRouter } from "./mail-router";
import { contactRouter } from "./contact-router";
import { settingsRouter } from "./settings-router";
import { createRouter, publicQuery } from "./middleware";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  account: accountRouter,
  rule: ruleRouter,
  mail: mailRouter,
  contact: contactRouter,
  settings: settingsRouter,

  // TODO: add feature routers here, e.g.
  // todo: createRouter({
  //   list: publicQuery.query(() => findTodos()),
  // }),
});

export type AppRouter = typeof appRouter;

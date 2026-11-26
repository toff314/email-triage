import { z } from "zod";
import { createRouter, authedQuery } from "./middleware";
import { getSettings, setSettings } from "./queries/settings";
import { encryptSecret, decryptSecret } from "./lib/crypto";

/** 数值型设置的范围（前端设置页共用） */
export const SETTING_LIMITS = {
  listLimit: { min: 10, max: 200, fallback: 50 },
  runLimit: { min: 10, max: 500, fallback: 100 },
  aiPerFolder: { min: 5, max: 50, fallback: 15 },
  aiTotal: { min: 20, max: 500, fallback: 120 },
} as const;

const numSetting = (key: keyof typeof SETTING_LIMITS) =>
  z
    .number()
    .int()
    .min(SETTING_LIMITS[key].min)
    .max(SETTING_LIMITS[key].max)
    .optional();

const input = z.object({
  listLimit: numSetting("listLimit"),
  runLimit: numSetting("runLimit"),
  aiPerFolder: numSetting("aiPerFolder"),
  aiTotal: numSetting("aiTotal"),
  aiBaseUrl: z.string().max(200).optional(),
  aiModel: z.string().max(100).optional(),
  /** 留空字符串表示清除已保存的 key */
  aiKey: z.string().max(300).optional(),
  /** 是否自动记录联系人（写信地址补全），默认不记录 */
  collectContacts: z.boolean().optional(),
});

export type SettingsInput = z.infer<typeof input>;

export const settingsRouter = createRouter({
  /** 返回明文设置；aiKey 解密后仅回给本人，用于自动带出 */
  get: authedQuery.query(async ({ ctx }) => {
    const raw = await getSettings(ctx.user.id);
    let aiKey = "";
    if (raw.aiKey) {
      try {
        aiKey = decryptSecret(raw.aiKey);
      } catch {
        aiKey = "";
      }
    }
    return {
      listLimit: Number(raw.listLimit) || SETTING_LIMITS.listLimit.fallback,
      runLimit: Number(raw.runLimit) || SETTING_LIMITS.runLimit.fallback,
      aiPerFolder: Number(raw.aiPerFolder) || SETTING_LIMITS.aiPerFolder.fallback,
      aiTotal: Number(raw.aiTotal) || SETTING_LIMITS.aiTotal.fallback,
      aiBaseUrl: raw.aiBaseUrl ?? "",
      aiModel: raw.aiModel ?? "",
      aiKey,
      collectContacts: raw.collectContacts === "true",
    };
  }),

  set: authedQuery.input(input).mutation(async ({ ctx, input }) => {
    const { aiKey, ...rest } = input;
    await setSettings(ctx.user.id, {
      ...Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [k, v === undefined ? undefined : String(v)]),
      ),
      aiKey: aiKey === undefined ? undefined : aiKey ? encryptSecret(aiKey) : "",
    });
    return { ok: true };
  }),
});

/** 服务端读取某个数值设置（带兜底） */
export async function numSettingOf(userId: number, key: keyof typeof SETTING_LIMITS): Promise<number> {
  const all = await getSettings(userId);
  const n = Number(all[key]);
  const { min, max, fallback } = SETTING_LIMITS[key];
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** 服务端读取布尔设置（未设置时用兜底值） */
export async function boolSettingOf(userId: number, key: "collectContacts", fallback = false): Promise<boolean> {
  const all = await getSettings(userId);
  const v = all[key];
  if (v === undefined || v === "") return fallback;
  return v === "true";
}

/** 保存 AI 模型配置（诊断时自动调用，key 加密） */
export async function saveAiConfig(
  userId: number,
  cfg: { baseUrl: string; model: string; apiKey: string },
) {
  await setSettings(userId, {
    aiBaseUrl: cfg.baseUrl,
    aiModel: cfg.model,
    aiKey: encryptSecret(cfg.apiKey),
  });
}

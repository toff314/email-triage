import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { env } from "./env";

/** 由 appSecret 派生 AES-256-GCM 密钥（进程内缓存） */
let key: Buffer | null = null;
function getKey(): Buffer {
  if (!key) {
    key = createHash("sha256").update(env.appSecret).digest();
  }
  return key;
}

/** 加密明文，输出 "iv:tag:ciphertext"（base64），失败抛错 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** 解密 encryptSecret 的输出；格式非法时抛错 */
export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("invalid secret payload");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

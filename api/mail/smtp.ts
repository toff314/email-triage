import nodemailer from "nodemailer";
import type { MailAccount } from "@db/schema";
import { decryptSecret } from "../lib/crypto";
import { loginUser } from "./imap";

export interface SendInput {
  to: string;
  cc?: string;
  subject: string;
  text: string;
}

/** 通过账号的 SMTP 发送邮件 */
export async function sendMail(account: MailAccount, input: SendInput): Promise<void> {
  if (!account.smtpHost) throw new Error("该账号未配置 SMTP，无法发送");
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: { user: loginUser(account), pass: decryptSecret(account.passwordEnc) },
    connectionTimeout: 20_000,
  });
  await transporter.sendMail({
    from: `"${account.label}" <${account.email}>`,
    to: input.to,
    cc: input.cc || undefined,
    subject: input.subject,
    text: input.text,
  });
}

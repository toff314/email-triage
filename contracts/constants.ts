export const Session = {
  cookieName: "kimi_sid",
  maxAgeMs: 365 * 24 * 60 * 60 * 1000,
} as const;

export const ErrorMessages = {
  unauthenticated: "Authentication required",
  insufficientRole: "Insufficient permissions",
} as const;

export const Paths = {
  login: "/login",
  oauthCallback: "/api/oauth/callback",
} as const;

/** 常见邮箱服务商的 IMAP/SMTP 地址：填邮箱地址时按后缀自动带出 */
export const MAIL_SERVER_PRESETS: Record<string, { imap: string; smtp: string }> = {
  "163.com": { imap: "imap.163.com", smtp: "smtp.163.com" },
  "126.com": { imap: "imap.126.com", smtp: "smtp.126.com" },
  "yeah.net": { imap: "imap.yeah.net", smtp: "smtp.yeah.net" },
  "qq.com": { imap: "imap.qq.com", smtp: "smtp.qq.com" },
  "foxmail.com": { imap: "imap.qq.com", smtp: "smtp.qq.com" },
  "gmail.com": { imap: "imap.gmail.com", smtp: "smtp.gmail.com" },
  "outlook.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "hotmail.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "live.com": { imap: "outlook.office365.com", smtp: "smtp.office365.com" },
  "sina.com": { imap: "imap.sina.com", smtp: "smtp.sina.com" },
  "sina.cn": { imap: "imap.sina.cn", smtp: "smtp.sina.cn" },
  "sohu.com": { imap: "imap.sohu.com", smtp: "smtp.sohu.com" },
  "aliyun.com": { imap: "imap.aliyun.com", smtp: "smtp.aliyun.com" },
  "139.com": { imap: "imap.139.com", smtp: "smtp.139.com" },
  "189.cn": { imap: "imap.189.cn", smtp: "smtp.189.cn" },
};

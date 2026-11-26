/** OpenAI 兼容的 chat completions 调用 */
export async function callChatCompletions(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
}): Promise<string> {
  const url = opts.baseUrl.trim().replace(/\/+$/, "") + "/chat/completions";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: opts.model.trim(),
        temperature: 0,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new Error(
      `无法连接模型服务：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`模型服务返回 ${res.status}：${text}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型返回内容为空");
  return content;
}

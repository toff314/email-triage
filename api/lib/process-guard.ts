import { log } from "./logger";

// TiDB 服务端会主动断开空闲连接，mysql2 抛出的连接级错误（如 ETIMEOUT）
// 没有调用方兜底时，会以 uncaughtException / unhandledRejection 冒到进程顶层，
// 直接把整个 dev server 打死。这里统一兜底：记日志后吞掉，进程继续跑；
// 请求级的真实错误仍由 tRPC 正常返回给调用方，不受影响。
let installed = false;

export function installProcessGuard() {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException swallowed", { err: String((err as Error)?.stack ?? err) });
  });
  process.on("unhandledRejection", (reason) => {
    const r = reason as Error | undefined;
    log.error("unhandledRejection swallowed", { err: String(r?.stack ?? reason) });
  });
}

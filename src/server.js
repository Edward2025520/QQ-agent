// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';

process.on('unhandledRejection', (error) => console.error('[未处理异常]', error));
// 未捕获异常后进程处于未定义状态（定时器丢失/连接悬空），记录后退出，
// 交给外层（systemd/脚本守护）重启 —— 只打印不退出会"半死不活"地挂着
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

const app = createApp();
app.start().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

// systemd 停服务发的是 SIGTERM，只处理 SIGINT 会让每次 restart 都等满
// TimeoutStopSec（默认 90s）再被 SIGKILL —— 期间进程处于"正在退出"状态，
// 同机的 SSH 也会被拖慢。两个信号都接。
const shutdown = async (signal) => {
  console.log(`收到 ${signal}，退出中…`);
  // 兜底：app.stop() 卡住（连接没断干净）时 5 秒强制退出
  setTimeout(() => process.exit(0), 5000).unref();
  try { await app.stop(); } catch (error) { console.error('[退出异常]', error); }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

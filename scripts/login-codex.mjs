import { spawn } from 'node:child_process';
import { codexEnvironment, codexConfigArgs, codexStatus } from '../server/model-bridge.mjs';

const isolated = await codexEnvironment();
console.log(`Codex 使用独立 profile：${isolated.paths.profile}`);
console.log('仅使用正常 ChatGPT 登录；API 鉴权变量已从 CLI 子进程环境移除。');
const args = [...codexConfigArgs(isolated.paths), 'login'];
if (process.argv.includes('--status')) {
  try { await codexStatus(); console.log('已核验 ChatGPT 登录模式。'); }
  catch (error) { console.error(`${error.code}: ${error.message}`); process.exitCode = 1; }
} else {
if (process.argv.includes('--device-auth')) args.push('--device-auth');
const child = spawn(process.env.DW_CODEX_BIN || 'codex', args, { cwd: isolated.paths.root, env: isolated.env, stdio: 'inherit', windowsHide: true, shell: false });
child.once('error', () => { console.error('无法启动 Codex CLI。请设置 DW_CODEX_BIN 为实际 codex.exe 路径。'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
}

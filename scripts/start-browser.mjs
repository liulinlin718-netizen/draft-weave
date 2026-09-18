import path from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { checkedPath, ensureDirectory, PROJECT_ROOT, runtimePaths, childEnvironment } from '../server/paths.mjs';

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const port = Number(option('--port') || 6410);
if (!Number.isInteger(port) || port < 6410 || port > 6419) throw new Error('端口仅支持 6410–6419。');
const url = `http://127.0.0.1:${port}`;
try { const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (!response.ok) throw new Error('not ready'); }
catch { console.error('请先在另一终端运行 scripts/start.ps1，然后启动独立浏览器。'); process.exit(1); }
const windowsCandidates = [
  [process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'],
  [process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'],
  [process.env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'],
  [process.env.USERPROFILE, 'AppData/Local/Google/Chrome/Application/chrome.exe'],
].filter(([base]) => base).map(([base, suffix]) => path.join(base, suffix));
const candidates = option('--browser') ? [option('--browser')] : process.env.DW_BROWSER_BIN ? [process.env.DW_BROWSER_BIN]
  : process.platform === 'win32' ? windowsCandidates
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
let browser;
for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
if (!browser) { console.error('没有找到现有 Chrome/Edge。请用 -Browser 指定已有浏览器路径；本脚本不安装浏览器。'); process.exit(1); }
const paths = await runtimePaths();
const profile = await ensureDirectory(path.join(paths.runtime, 'browser-profiles', 'manual'), paths.dataRoot);
const cache = await ensureDirectory(path.join(paths.runtime, 'browser-cache', 'manual'), paths.dataRoot);
const downloads = await ensureDirectory(path.join(paths.dataRoot, 'outputs', 'downloads'), paths.dataRoot);
const defaultProfile = await ensureDirectory(path.join(profile, 'Default'), paths.dataRoot);
const prefsPath = await checkedPath(path.join(defaultProfile, 'Preferences'), paths.dataRoot);
let prefs = {};
try { prefs = JSON.parse(await readFile(prefsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
prefs.download = { ...prefs.download, default_directory: downloads, prompt_for_download: false, directory_upgrade: true };
prefs.savefile = { ...prefs.savefile, default_directory: downloads };
await writeFile(prefsPath, JSON.stringify(prefs), 'utf8');
const child = spawn(browser, [`--user-data-dir=${profile}`, `--disk-cache-dir=${cache}`, '--no-first-run', '--no-default-browser-check', '--disable-breakpad', '--disable-crash-reporter', url], { cwd: PROJECT_ROOT, env: childEnvironment(paths), detached: true, stdio: 'ignore', shell: false, windowsHide: false });
child.once('error', () => { console.error('独立浏览器启动失败。'); process.exitCode = 1; });
child.once('spawn', () => {
  console.log(`画布 ${url}\n浏览器 profile ${profile}\n下载目录 ${downloads}`);
  child.unref();
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, realpath, mkdir } from 'node:fs/promises';

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.runtime');

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Check both lexical scope and every existing ancestor, including junctions. */
export async function checkedPath(candidate, root = PROJECT_ROOT) {
  const absolute = path.resolve(candidate);
  root = path.resolve(root);
  if (!isWithin(root, absolute)) throw Object.assign(new Error('路径必须位于所选数据目录内。'), { code: 'UNSAFE_PATH' });
  let cursor = absolute;
  let nearest;
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw Object.assign(new Error('不允许 junction、软链接或重解析输出路径。'), { code: 'UNSAFE_PATH' });
      if (!nearest) nearest = cursor;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const realRoot = await realpath(root).catch(error => { if (error.code === 'ENOENT') return root; throw error; });
  if (nearest && isWithin(root, nearest) && !isWithin(realRoot, await realpath(nearest))) {
    throw Object.assign(new Error('路径实际位置超出所选数据目录。'), { code: 'UNSAFE_PATH' });
  }
  return absolute;
}

export async function ensureDirectory(candidate, root = PROJECT_ROOT) {
  const checked = await checkedPath(candidate, root);
  await mkdir(checked, { recursive: true });
  await checkedPath(checked, root);
  return checked;
}

export async function runtimePaths(env = process.env) {
  // Only startup configuration selects a data root; HTTP requests cannot change it.
  const dataRoot = path.resolve(env.DW_DATA_DIR || PROJECT_ROOT);
  await ensureDirectory(dataRoot, dataRoot);
  const runtime = path.join(dataRoot, '.runtime');
  const profile = path.resolve(env.CODEX_PROJECT_PROFILE_DIR || path.join(runtime, 'codex-profile'));
  const temp = path.join(runtime, 'temp');
  const sqlite = path.join(profile, 'sqlite');
  const paths = { root: dataRoot, dataRoot, runtime, profile, sqlite, temp,
    exports: path.join(dataRoot, 'outputs', 'exports'), model: path.join(runtime, 'model'),
    cache: path.join(runtime, 'cache'), config: path.join(runtime, 'config'), appData: path.join(runtime, 'app-data') };
  for (const directory of [profile, sqlite, temp, paths.exports, paths.model, paths.cache, paths.config, paths.appData]) await ensureDirectory(directory, dataRoot);
  return paths;
}

/** Contain child-process caches without changing the user's shell or global profile. */
export function childEnvironment(paths, env = process.env) {
  return { ...env, TEMP: paths.temp, TMP: paths.temp, TMPDIR: paths.temp,
    XDG_CACHE_HOME: paths.cache, XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.appData,
    APPDATA: paths.appData, LOCALAPPDATA: paths.appData };
}

/** Create an independent, allowlisted folder. No credentials, caches or QA artifacts. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { PROJECT_ROOT, checkedPath } from '../server/paths.mjs';

export async function packageApp(destination = path.join(PROJECT_ROOT, 'dist', 'draft-weave')) {
  const target = await checkedPath(destination);
  // Never delete or overwrite an existing release or user directory.
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(target);
  const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const copied = [];
  async function copy(relative) {
    const source = await checkedPath(path.join(PROJECT_ROOT, relative));
    if ((await stat(source)).isDirectory()) {
      for (const entry of await readdir(source)) await copy(path.join(relative, entry));
    } else {
      const output = await checkedPath(path.join(target, relative), target);
      await mkdir(path.dirname(output), { recursive: true });
      await copyFile(source, output); copied.push(relative.replaceAll('\\', '/'));
    }
  }
  for (const relative of ['README.md', 'README.zh-CN.md', 'LICENSE', 'docs/images/review.png', ...manifest.files]) await copy(relative);
  await writeFile(path.join(target, 'package.json'), JSON.stringify({ ...manifest, scripts: { start: manifest.scripts.start } }, null, 2) + '\n');
  copied.push('package.json');
  return { directory: target, files: copied.sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  packageApp(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.code === 'EEXIST' ? '目标已存在。请选择新的发行目录；不会覆盖已有文件。' : error.message); process.exitCode = 1; });
}

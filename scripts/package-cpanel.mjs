#!/usr/bin/env node
/**
 * Builds upload bundles for cPanel "Setup Node.js App" (Phusion Passenger):
 *   deploy/cpanel/livesell-api.zip  -> extract into ~/livesell-api; app root livesell-api/api, startup dist/main.js
 *   deploy/cpanel/livesell-web.zip  -> extract into ~/livesell-web; app root livesell-web/apps/web, startup server.js
 * Both carry their node_modules one level above the app root: nothing is installed on the server (the hosting memory
 * limit and cPanel's installer are avoided), and the cPanel Node.js selector sees no node_modules in the app root.
 *
 * Usage: node scripts/package-cpanel.mjs --api-url https://api.sell.innovative.ng
 * Contains no secrets: the API reads its settings from the environment variables set in cPanel.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const apiUrl = arg('api-url', 'https://api.sell.innovative.ng');
if (!/^https:\/\/[^/]+$/.test(apiUrl)) throw new Error(`--api-url must be https://host with no path (got ${apiUrl})`);

const out = join(root, 'deploy', 'cpanel');
const run = (cmd, cwd, env = {}) => {
  console.log(`\n> ${cmd}   (${cwd.replace(root, '.') || '.'})`);
  execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
};
const zip = (dir, file) => {
  rmSync(file, { force: true });
  // bsdtar writes .zip from the extension (Windows 10+ System32, macOS). On Linux use `bsdtar` (libarchive-tools).
  const tar = process.platform === 'win32' ? `"${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')}"`
    : process.platform === 'darwin' ? 'tar' : 'bsdtar';
  run(`${tar} -a -c -f "${file}" -C "${dir}" .`, root);
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ── API ──
const apiDir = join(root, 'apps', 'api');
run('npx prisma generate', apiDir);
run('npx nest build', apiDir);
const apiOut = join(out, 'api');
cpSync(join(apiDir, 'dist'), join(apiOut, 'api', 'dist'), { recursive: true });
writeFileSync(join(apiOut, 'api', 'package.json'), JSON.stringify({ name: 'livesell-api-app', private: true, main: 'dist/main.js' }, null, 2));
const apiPkg = JSON.parse(readFileSync(join(apiDir, 'package.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(
  join(apiOut, 'package.json'),
  JSON.stringify(
    {
      name: 'livesell-api',
      private: true,
      version: apiPkg.version ?? '1.0.0',
      scripts: { start: 'node api/dist/main.js' },
      engines: { node: '>=22' },
      dependencies: apiPkg.dependencies,
      overrides: rootPkg.overrides ?? {},
    },
    null,
    2,
  ),
);
// Runtime dependencies only. All pure JS except argon2, which ships a prebuilt linux-x64 binary (loaded at runtime), so a
// Windows/macOS install runs on the Linux server. Prisma 7 (adapter-pg) needs no engine binary at runtime.
run('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', apiOut);
run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', apiOut);
if (!existsSync(join(apiOut, 'node_modules', 'argon2', 'prebuilds', 'linux-x64'))) throw new Error('argon2 linux-x64 prebuild missing');
rmSync(join(apiOut, 'node_modules', '.bin'), { recursive: true, force: true }); // Windows shims, useless on Linux
zip(apiOut, join(out, 'livesell-api.zip'));

// ── Web ──
const webDir = join(root, 'apps', 'web');
run('npx next build', webDir, { NEXT_PUBLIC_API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: '.next-cpanel' });
const standalone = join(webDir, '.next-cpanel', 'standalone');
if (!existsSync(join(standalone, 'apps', 'web', 'server.js'))) throw new Error('standalone server.js not found');
const webOut = join(out, 'web');
cpSync(standalone, webOut, { recursive: true, dereference: true });
cpSync(join(webDir, '.next-cpanel', 'static'), join(webOut, 'apps', 'web', '.next-cpanel', 'static'), { recursive: true });
if (existsSync(join(webDir, 'public'))) cpSync(join(webDir, 'public'), join(webOut, 'apps', 'web', 'public'), { recursive: true });
for (const f of ['.env', '.env.local', '.env.production']) rmSync(join(webOut, 'apps', 'web', f), { force: true });
zip(webOut, join(out, 'livesell-web.zip'));

console.log(`\nDone (API URL baked into the web app: ${apiUrl}):\n  ${join(out, 'livesell-api.zip')}\n  ${join(out, 'livesell-web.zip')}`);

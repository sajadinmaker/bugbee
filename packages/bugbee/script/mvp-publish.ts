#!/usr/bin/env bun
/**
 * MVP publisher: npm platform packages + meta `bugbee` only.
 * Skips Docker, AUR, Homebrew (use full publish.ts + BUGBEE_PUBLISH_EXTRAS later).
 *
 * Prerequisites:
 *   - packages/bugbee/dist/* built (see script/build.ts)
 *   - NODE_AUTH_TOKEN set for registry.npmjs.org
 *   - BUGBEE_VERSION / BUGBEE_RELEASE so Script.version is the release version
 */
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@bugbee-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const tag = Script.channel === "latest" ? "latest" : Script.channel
const delayMs = Number(process.env.NPM_PUBLISH_DELAY_MS ?? 8000)
const maxAttempts = Number(process.env.NPM_PUBLISH_RETRIES ?? 6)

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publishPackage(packageDir: string, name: string, version: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(packageDir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }

  // Clean previous packs so `npm publish *.tgz` is unambiguous
  await $`rm -f *.tgz`.cwd(packageDir).nothrow()
  await $`bun pm pack`.cwd(packageDir)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await $`npm publish *.tgz --access public --tag ${tag}`.cwd(packageDir).nothrow()
    if (result.exitCode === 0) {
      console.log(`published ${name}@${version}`)
      await sleep(delayMs)
      return
    }

    const stderr = result.stderr.toString("utf8")
    const retriable = /E429|Too Many Requests|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(stderr)
    if (!retriable || attempt === maxAttempts) {
      console.error(stderr)
      throw new Error(`npm publish failed for ${name}@${version} (attempt ${attempt}/${maxAttempts})`)
    }

    const wait = delayMs * attempt
    console.log(`rate-limited publishing ${name}; retry ${attempt}/${maxAttempts} in ${wait}ms`)
    await sleep(wait)
  }
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  if (filepath === `${pkg.name}/package.json`) continue
  const meta = await Bun.file(`./dist/${filepath}`).json()
  if (!meta.name || !meta.version) continue
  // Only platform packages (bugbee-linux-x64, …), not the meta package dir
  if (meta.name === pkg.name) continue
  binaries[meta.name] = meta.version
}

if (Object.keys(binaries).length === 0) {
  console.error("No platform packages found under packages/bugbee/dist/")
  console.error("Run: BUGBEE_VERSION=… BUGBEE_RELEASE=1 bun run --cwd packages/bugbee script/build.ts")
  process.exit(1)
}

const version = Object.values(binaries)[0]
const platformNames = Object.keys(binaries).sort()
console.log("mvp-publish", { version, channel: tag, platforms: platformNames })

await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
  [
    `echo "Error: ${pkg.name}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${pkg.name} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${pkg.name} without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

// Bare name `bugbee` is blocked by npm (too similar to existing package `buble`).
// Publish the installable CLI under the scoped name; binary remains `bugbee`.
const publishName = process.env.BUGBEE_NPM_NAME ?? "@neuralbroker/bugbee"

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: publishName,
      description: "Bugbee — open source AI coding agent",
      repository: {
        type: "git",
        url: "https://github.com/sajadinmaker/bugbee",
      },
      homepage: "https://github.com/sajadinmaker/bugbee",
      bin: {
        bugbee: `./bin/${pkg.name}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

// Publish remaining platform packages first (skip already published), then meta.
for (const name of platformNames) {
  await publishPackage(`./dist/${name}`, name, binaries[name])
}
await publishPackage(`./dist/${pkg.name}`, publishName, version)

console.log(`\nmvp-publish done: npm install -g ${publishName}@${version}`)

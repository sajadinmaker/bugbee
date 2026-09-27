#!/usr/bin/env bun
/**
 * Publish any missing platform packages for a GitHub release version,
 * then ensure @neuralbroker/bugbee meta package lists all available platforms.
 *
 * Env:
 *   BUGBEE_VERSION   e.g. 1.0.0
 *   NODE_AUTH_TOKEN  npm token
 *   NPM_PUBLISH_DELAY_MS (default 30000)
 *   NPM_PUBLISH_RETRIES (default 12)
 *   NPM_PUBLISH_COOLDOWN_MS (default 60000)
 *   BUGBEE_ONLY_MISSING (default 1)
 */
import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"

const version = (process.env.BUGBEE_VERSION ?? process.env.VERSION ?? "").replace(/^v/, "")
if (!version) {
  console.error("BUGBEE_VERSION is required (e.g. 1.0.0)")
  process.exit(1)
}
if (!process.env.NODE_AUTH_TOKEN) {
  console.error("NODE_AUTH_TOKEN is required")
  process.exit(1)
}

const delayMs = Number(process.env.NPM_PUBLISH_DELAY_MS ?? 30_000)
const maxAttempts = Number(process.env.NPM_PUBLISH_RETRIES ?? 12)
const onlyMissing = (process.env.BUGBEE_ONLY_MISSING ?? "1") === "1"
const initialCooldownMs = Number(process.env.NPM_PUBLISH_COOLDOWN_MS ?? 60_000)
const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
const work = path.join(root, "packages/bugbee/dist/remaining-publish")
const base = `https://github.com/sajadinmaker/bugbee/releases/download/v${version}`
const metaName = "@neuralbroker/bugbee"
const scope = "@neuralbroker"

type Platform = {
  /** Preferred unscoped npm name (historical) */
  name: string
  /** Fallback scoped name if unscoped creation is rate-limited */
  scopedName: string
  archive: string
  binary: string
  os: string
  cpu: string
}

const platforms: Platform[] = [
  {
    name: "bugbee-linux-x64",
    scopedName: `${scope}/bugbee-linux-x64`,
    archive: `${base}/bugbee-linux-x64.tar.gz`,
    binary: "bugbee",
    os: "linux",
    cpu: "x64",
  },
  {
    name: "bugbee-linux-x64-baseline",
    scopedName: `${scope}/bugbee-linux-x64-baseline`,
    archive: `${base}/bugbee-linux-x64-baseline.tar.gz`,
    binary: "bugbee",
    os: "linux",
    cpu: "x64",
  },
  {
    name: "bugbee-linux-x64-musl",
    scopedName: `${scope}/bugbee-linux-x64-musl`,
    archive: `${base}/bugbee-linux-x64-musl.tar.gz`,
    binary: "bugbee",
    os: "linux",
    cpu: "x64",
  },
  {
    name: "bugbee-linux-x64-baseline-musl",
    scopedName: `${scope}/bugbee-linux-x64-baseline-musl`,
    archive: `${base}/bugbee-linux-x64-baseline-musl.tar.gz`,
    binary: "bugbee",
    os: "linux",
    cpu: "x64",
  },
  {
    name: "bugbee-linux-arm64",
    scopedName: `${scope}/bugbee-linux-arm64`,
    archive: `${base}/bugbee-linux-arm64.tar.gz`,
    binary: "bugbee",
    os: "linux",
    cpu: "arm64",
  },
  {
    name: "bugbee-linux-arm64-musl",
    scopedName: `${scope}/bugbee-linux-arm64-musl`,
    archive: `${base}/bugbee-linux-arm64-musl.tar.gz`,
    binary: "bugbee",
    os: "linux",
    cpu: "arm64",
  },
  {
    name: "bugbee-darwin-x64",
    scopedName: `${scope}/bugbee-darwin-x64`,
    archive: `${base}/bugbee-darwin-x64.zip`,
    binary: "bugbee",
    os: "darwin",
    cpu: "x64",
  },
  {
    name: "bugbee-darwin-x64-baseline",
    scopedName: `${scope}/bugbee-darwin-x64-baseline`,
    archive: `${base}/bugbee-darwin-x64-baseline.zip`,
    binary: "bugbee",
    os: "darwin",
    cpu: "x64",
  },
  {
    name: "bugbee-darwin-arm64",
    scopedName: `${scope}/bugbee-darwin-arm64`,
    archive: `${base}/bugbee-darwin-arm64.zip`,
    binary: "bugbee",
    os: "darwin",
    cpu: "arm64",
  },
  {
    name: "bugbee-windows-x64",
    scopedName: `${scope}/bugbee-windows-x64`,
    archive: `${base}/bugbee-windows-x64.zip`,
    binary: "bugbee.exe",
    os: "win32",
    cpu: "x64",
  },
  {
    name: "bugbee-windows-x64-baseline",
    scopedName: `${scope}/bugbee-windows-x64-baseline`,
    archive: `${base}/bugbee-windows-x64-baseline.zip`,
    binary: "bugbee.exe",
    os: "win32",
    cpu: "x64",
  },
  {
    name: "bugbee-windows-arm64",
    scopedName: `${scope}/bugbee-windows-arm64`,
    archive: `${base}/bugbee-windows-arm64.zip`,
    binary: "bugbee.exe",
    os: "win32",
    cpu: "arm64",
  },
]

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function published(name: string, ver = version) {
  return (await $`npm view ${name}@${ver} version`.nothrow()).exitCode === 0
}

async function npmPublish(dir: string, label: string) {
  await $`rm -f *.tgz`.cwd(dir).nothrow()
  await $`npm pack`.cwd(dir).quiet()
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await $`npm publish *.tgz --access public --tag latest`.cwd(dir).nothrow()
    if (result.exitCode === 0) {
      console.log(`published ${label}`)
      await sleep(delayMs)
      return true
    }
    const stderr = result.stderr.toString("utf8")
    const retriable = /E429|Too Many Requests|ETIMEDOUT|ECONNRESET|network|socket/i.test(stderr)
    if (!retriable || attempt === maxAttempts) {
      console.error(stderr)
      return false
    }
    const wait = Math.min(delayMs * attempt, 180_000)
    console.log(`retry ${attempt}/${maxAttempts} for ${label} in ${wait}ms`)
    await sleep(wait)
  }
  return false
}

async function materialize(p: Platform, pkgName: string) {
  const dir = path.join(work, pkgName.replace("/", "__"))
  await $`rm -rf ${dir}`
  await $`mkdir -p ${path.join(dir, "bin")}`
  const asset = path.join(work, `${p.name}.asset`)
  if (!(await Bun.file(asset).exists())) {
    console.log(`downloading ${p.archive}`)
    await $`curl -fsSL -o ${asset} ${p.archive}`
  }
  if (p.archive.endsWith(".zip")) {
    await $`unzip -qo ${asset} -d ${path.join(dir, "bin")}`
  } else {
    await $`tar -xzf ${asset} -C ${path.join(dir, "bin")}`
  }

  const binDir = path.join(dir, "bin")
  const wanted = path.join(binDir, p.binary)
  const plain = path.join(binDir, "bugbee")
  if (p.binary === "bugbee.exe" && (await Bun.file(plain).exists()) && !(await Bun.file(wanted).exists())) {
    await $`mv ${plain} ${wanted}`
  }
  if (!(await Bun.file(wanted).exists())) {
    await $`ls -la ${binDir}`
    throw new Error(`missing binary ${wanted}`)
  }
  await $`chmod 755 ${wanted}`.nothrow()

  await Bun.file(path.join(dir, "package.json")).write(
    JSON.stringify(
      {
        name: pkgName,
        version,
        preferUnplugged: true,
        os: [p.os],
        cpu: [p.cpu],
      },
      null,
      2,
    ) + "\n",
  )
  return dir
}

async function publishPlatform(p: Platform) {
  // Prefer unscoped if present or creatable; else scoped fallback.
  if (await published(p.name)) {
    console.log(`already on npm: ${p.name}@${version}`)
    return p.name
  }
  if (await published(p.scopedName)) {
    console.log(`already on npm: ${p.scopedName}@${version}`)
    return p.scopedName
  }

  console.log(`=== publishing ${p.name} (unscoped) ===`)
  try {
    const dir = await materialize(p, p.name)
    if (await npmPublish(dir, `${p.name}@${version}`)) return p.name
  } catch (error) {
    console.error(error)
  }

  console.log(`=== fallback scoped ${p.scopedName} ===`)
  const dir = await materialize(p, p.scopedName)
  if (await npmPublish(dir, `${p.scopedName}@${version}`)) return p.scopedName
  throw new Error(`failed to publish ${p.name} and ${p.scopedName}`)
}

async function listAvailable() {
  const deps: Record<string, string> = {}
  for (const p of platforms) {
    if (await published(p.name)) deps[p.name] = version
    else if (await published(p.scopedName)) deps[p.scopedName] = version
  }
  return deps
}

async function ensureMeta(deps: Record<string, string>) {
  if (Object.keys(deps).length === 0) throw new Error("no platform packages on npm")

  let metaVersion = version
  if (await published(metaName, version)) {
    const raw = await $`npm view ${metaName}@${version} optionalDependencies --json`.nothrow()
    const got = raw.exitCode === 0 ? (JSON.parse(raw.stdout.toString("utf8") || "{}") as Record<string, string>) : {}
    const missing = Object.keys(deps).filter((k) => !got[k])
    if (missing.length === 0) {
      console.log(`meta ${metaName}@${version} already complete`)
      return
    }
    const parts = version.split(".")
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1)
    metaVersion = parts.join(".")
    console.log(`meta incomplete (missing ${missing.join(", ")}); publishing ${metaName}@${metaVersion}`)
  }

  const dir = path.join(work, "meta")
  await $`rm -rf ${dir}`
  await $`mkdir -p ${path.join(dir, "bin")}`
  await $`cp ${path.join(root, "packages/bugbee/script/postinstall.mjs")} ${path.join(dir, "postinstall.mjs")}`
  await $`cp ${path.join(root, "LICENSE")} ${path.join(dir, "LICENSE")}`
  await Bun.file(path.join(dir, "bin/bugbee.exe")).write(
    [
      "#!/bin/sh",
      'echo "Error: bugbee postinstall did not run. Reinstall with: npm install -g @neuralbroker/bugbee" >&2',
      "exit 1",
      "",
    ].join("\n"),
  )
  await $`chmod 755 ${path.join(dir, "bin/bugbee.exe")}`
  await Bun.file(path.join(dir, "package.json")).write(
    JSON.stringify(
      {
        name: metaName,
        description: "Bugbee — open source AI coding agent",
        repository: { type: "git", url: "https://github.com/sajadinmaker/bugbee" },
        homepage: "https://github.com/sajadinmaker/bugbee",
        bin: { bugbee: "./bin/bugbee.exe" },
        scripts: { postinstall: "node ./postinstall.mjs" },
        version: metaVersion,
        license: "MIT",
        os: ["darwin", "linux", "win32"],
        cpu: ["arm64", "x64"],
        optionalDependencies: deps,
      },
      null,
      2,
    ) + "\n",
  )
  if (!(await npmPublish(dir, `${metaName}@${metaVersion}`))) {
    throw new Error(`failed to publish meta ${metaName}@${metaVersion}`)
  }
}

await $`rm -rf ${work}`
await $`mkdir -p ${work}`
console.log("publish-remaining", { version, delayMs, maxAttempts, onlyMissing, initialCooldownMs })

if (initialCooldownMs > 0) {
  console.log(`cooldown ${initialCooldownMs}ms before publishing...`)
  await sleep(initialCooldownMs)
}

const failures: string[] = []
for (const p of platforms) {
  if (onlyMissing && ((await published(p.name)) || (await published(p.scopedName)))) {
    console.log(`skip present: ${p.name}`)
    continue
  }
  try {
    await publishPlatform(p)
  } catch (error) {
    console.error(error)
    failures.push(p.name)
  }
}

const deps = await listAvailable()
console.log("available platforms", Object.keys(deps).sort())
await ensureMeta(deps)

console.log("\n=== inventory ===")
const latest = await $`npm view ${metaName} version`.nothrow()
console.log(`${metaName}: ${latest.exitCode === 0 ? latest.stdout.toString("utf8").trim() : "MISSING"}`)
for (const p of platforms) {
  const unscoped = await published(p.name)
  const scoped = await published(p.scopedName)
  console.log(`${p.name}: ${unscoped ? version : scoped ? p.scopedName + "@" + version : "MISSING"}`)
}

if (failures.length) {
  console.error("platform publish failures:", failures.join(", "))
  process.exit(1)
}
console.log("publish-remaining done")

#!/usr/bin/env node

import childProcess from "child_process"
import fs from "fs"
import https from "https"
import http from "http"
import os from "os"
import path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import { createWriteStream } from "fs"
import { pipeline } from "stream/promises"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"))

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
}
const archMap = {
  x64: "x64",
  arm64: "arm64",
  arm: "arm",
}

const platform = platformMap[os.platform()] ?? os.platform()
const arch = archMap[os.arch()] ?? os.arch()
const base = `bugbee-${platform}-${arch}`
const sourceBinary = platform === "windows" ? "bugbee.exe" : "bugbee"
const targetBinary = path.join(__dirname, "bin", "bugbee.exe")
const releaseVersion = String(packageJson.version || "").replace(/^v/, "")

function supportsAvx2() {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    const command =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const executable of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const output = (result.stdout || "").trim().toLowerCase()
        if (output === "true" || output === "1") return true
        if (output === "false" || output === "0") return false
      } catch {
        continue
      }
    }
  }

  return false
}

function isMusl() {
  if (platform !== "linux") return false

  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // Ignore filesystem probes that are blocked by the host.
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return `${result.stdout || ""}${result.stderr || ""}`.toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function packageNames() {
  const baseline = arch === "x64" && !supportsAvx2()
  let names = []

  if (platform === "linux") {
    if (isMusl()) {
      if (arch === "x64")
        names = baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
      else names = [`${base}-musl`, base]
    } else if (arch === "x64") {
      names = baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
    } else {
      names = [base, `${base}-musl`]
    }
  } else if (arch === "x64") {
    names = baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`]
  } else {
    names = [base]
  }

  // Prefer unscoped historical names, then scoped fallbacks under @neuralbroker/*
  return names.flatMap((name) => [name, `@neuralbroker/${name}`])
}

function releaseAssets() {
  const baseline = arch === "x64" && !supportsAvx2()
  const ext = platform === "linux" ? ".tar.gz" : ".zip"
  const tags = []
  if (platform === "linux") {
    if (isMusl()) {
      if (arch === "x64") tags.push(baseline ? `${base}-baseline-musl` : `${base}-musl`, base)
      else tags.push(`${base}-musl`, base)
    } else if (arch === "x64") {
      tags.push(baseline ? `${base}-baseline` : base, base)
    } else {
      tags.push(base)
    }
  } else if (arch === "x64") {
    tags.push(baseline ? `${base}-baseline` : base, base)
  } else {
    tags.push(base)
  }
  return [...new Set(tags)].map((tag) => `${tag}${ext}`)
}

function resolveBinary(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`)
  const binaryPath = path.join(path.dirname(packageJsonPath), "bin", sourceBinary)
  if (!fs.existsSync(binaryPath)) throw new Error(`Binary not found at ${binaryPath}`)
  return binaryPath
}

function installPackage(name) {
  const version = packageJson.optionalDependencies?.[name]
  if (!version) return

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bugbee-install-"))
  try {
    const result = childProcess.spawnSync(
      "npm",
      ["install", "--ignore-scripts", "--no-save", "--loglevel=error", "--prefix", temp, `${name}@${version}`],
      { stdio: "inherit", windowsHide: true },
    )
    if (result.status !== 0) return
    const packageDir = path.join(temp, "node_modules", ...name.split("/"))
    copyBinary(path.join(packageDir, "bin", sourceBinary), targetBinary)
    return true
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function copyBinary(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Binary not found at ${source}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) fs.unlinkSync(target)
  try {
    fs.linkSync(source, target)
  } catch {
    fs.copyFileSync(source, target)
  }
  fs.chmodSync(target, 0o755)
}

function verifyBinary() {
  const result = childProcess.spawnSync(targetBinary, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  })
  return result.status === 0
}

function fetchFollow(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 8) return reject(new Error(`too many redirects for ${url}`))
    const lib = url.startsWith("https:") ? https : http
    const req = lib.get(url, { headers: { "User-Agent": "bugbee-postinstall" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(fetchFollow(res.headers.location, dest, redirects + 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`download failed ${res.statusCode} for ${url}`))
      }
      const out = createWriteStream(dest)
      pipeline(res, out).then(resolve).catch(reject)
    })
    req.on("error", reject)
  })
}

async function installFromGitHubRelease() {
  if (!releaseVersion) return false
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bugbee-release-"))
  try {
    for (const asset of releaseAssets()) {
      const url = `https://github.com/sajadinmaker/bugbee/releases/download/v${releaseVersion}/${asset}`
      const archive = path.join(temp, asset)
      try {
        await fetchFollow(url, archive)
      } catch {
        continue
      }

      const extractDir = path.join(temp, "out")
      fs.mkdirSync(extractDir, { recursive: true })
      if (asset.endsWith(".tar.gz")) {
        const result = childProcess.spawnSync("tar", ["-xzf", archive, "-C", extractDir], { encoding: "utf8" })
        if (result.status !== 0) continue
      } else {
        // Prefer unzip; fall back to tar which handles zip on some systems
        let result = childProcess.spawnSync("unzip", ["-qo", archive, "-d", extractDir], { encoding: "utf8" })
        if (result.status !== 0) {
          result = childProcess.spawnSync("tar", ["-xf", archive, "-C", extractDir], { encoding: "utf8" })
          if (result.status !== 0) continue
        }
      }

      const candidate = path.join(extractDir, sourceBinary)
      const alt = path.join(extractDir, "bugbee")
      const source = fs.existsSync(candidate) ? candidate : fs.existsSync(alt) ? alt : null
      if (!source) continue
      copyBinary(source, targetBinary)
      if (verifyBinary()) return true
    }
    return false
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

async function main() {
  for (const name of packageNames()) {
    try {
      copyBinary(resolveBinary(name), targetBinary)
      if (verifyBinary()) return
    } catch {
      if (installPackage(name) && verifyBinary()) return
    }
  }

  // npm may be missing some platform packages (rate limits / name blocks).
  // Fall back to the matching GitHub Release asset for this package version.
  if (await installFromGitHubRelease()) return

  throw new Error(
    `Failed to install the Bugbee binary for ${platform}/${arch}. ` +
      `Try: curl -fsSL https://github.com/sajadinmaker/bugbee/install | bash ` +
      `or manually install one of: ${packageNames().map((name) => JSON.stringify(name)).join(", ")}.`,
  )
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})

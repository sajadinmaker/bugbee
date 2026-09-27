import { expect, test } from "bun:test"

const docsRoot = new URL("../src/content/docs/", import.meta.url).pathname

test("documentation auth links use the canonical Bugbee product URL", async () => {
  const files = await Array.fromAsync(new Bun.Glob("**/*.mdx").scan({ cwd: docsRoot, absolute: true }))
  const invalid = await Promise.all(
    files.map(async (file) => {
      const content = await Bun.file(file).text()
      return content.includes("bugbee.dev/auth](https://github.com/sajadinmaker/bugbee/") ? file : undefined
    }),
  ).then((items) => items.filter((item): item is string => item !== undefined))

  expect(invalid).toEqual([])
})

test("CLI documentation covers the guided setup flow", async () => {
  const content = await Bun.file(new URL("../src/content/docs/cli.mdx", import.meta.url)).text()

  expect(content).toContain("### setup")
  expect(content).toContain("### doctor")
  expect(content).toContain("bugbee setup --json")
  expect(content).toContain("bugbee doctor --json")
  expect(content).toContain("bugbee providers [command]")
  expect(content).toContain("/connect")
  expect(content).toContain("/doctor")
  expect(content).toContain("/init")
  expect(content).toContain("https://opncd.ai/share/abc123")
  expect(content).not.toContain("https://opncd.ai/s/abc123")
})

test("getting started documentation points to guided setup", async () => {
  const content = await Bun.file(new URL("../src/content/docs/index.mdx", import.meta.url)).text()

  expect(content).toContain("bugbee setup")
  expect(content).toContain("checks your local installation")
})

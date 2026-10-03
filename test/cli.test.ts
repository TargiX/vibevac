import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, {recursive:true,force:true})));
});
const cli = resolve("src/cli.ts");
async function fixture() {
  const home = await mkdtemp(resolve(tmpdir(), "vibevac-cli-"));
  roots.push(home);
  const root = resolve(home, "project");
  await run("git", ["init", "-b", "main", root]);
  await run("git", ["-C", root, "config", "user.name", "Test"]);
  await run("git", ["-C", root, "config", "user.email", "test@example.test"]);
  await writeFile(resolve(root, ".gitignore"), "node_modules/\n");
  await writeFile(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(resolve(root, "source.ts"), "valuable source\n");
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "-m", "fixture"]);
  await mkdir(resolve(root, "node_modules/pkg"), {recursive:true});
  await writeFile(resolve(root, "node_modules/pkg/file.js"), "generated dependency");
  const invoke = (...args:string[]) => run(process.execPath, ["--import", "tsx", cli, ...args], {
    env:{...process.env,HOME:home}, maxBuffer:2*1024*1024,
  });
  return {root,home,invoke};
}

describe("CLI cleanup", () => {
  it("previews by default, refuses wrong confirmation, and executes the exact selection", async () => {
    const {root,home,invoke} = await fixture();
    const preview = JSON.parse((await invoke("clean",root,"--cache","node_modules","--json")).stdout);
    await expect(access(resolve(root,"node_modules"))).resolves.toBeUndefined();
    await expect(invoke("clean",root,"--all","--execute","--confirm","WRONG")).rejects.toThrow();
    await expect(access(resolve(root,"node_modules"))).resolves.toBeUndefined();
    const result = JSON.parse((await invoke("clean",root,"--cache","node_modules","--execute","--confirm",preview.confirmation,"--json")).stdout);
    expect(result.removed.map((c:{relativePath:string})=>c.relativePath)).toEqual(["node_modules"]);
    await expect(access(resolve(root,"node_modules"))).rejects.toThrow();
    expect(await readFile(resolve(root,"source.ts"),"utf8")).toBe("valuable source\n");
    expect(await readFile(resolve(home,".vibevac/audit.jsonl"),"utf8")).toContain('"action":"cache-cleanup"');
  }, 30_000);

  it("requires one explicit cache scope", async () => {
    const {root,invoke} = await fixture();
    await expect(invoke("clean",root)).rejects.toThrow();
    await expect(invoke("clean",root,"--all","--cache","node_modules")).rejects.toThrow();
    await expect(access(resolve(root,"node_modules"))).resolves.toBeUndefined();
  });

  it("inspects the requested repository rather than a larger registered worktree", async () => {
    const {root,home,invoke} = await fixture();
    const child = resolve(home,"child");
    await run("git",["-C",root,"worktree","add","-b","child",child]);
    await mkdir(resolve(child,"node_modules/pkg"),{recursive:true});
    await writeFile(resolve(child,"node_modules/pkg/large"),Buffer.alloc(3*1024*1024));
    await writeFile(resolve(child,"source.ts"),"unique child source");
    const result = JSON.parse((await invoke("inspect",root,"--json")).stdout);
    expect(result.path).toBe(await realpath(root));
  }, 30_000);
});

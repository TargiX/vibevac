import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { inventoryRebuildableCaches } from "../src/services/cache-inventory.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRepository(withLockfile = true): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "vibevac-cache-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "-b", "main", root], { encoding: "utf8" });
  await writeFile(resolve(root, ".gitignore"), "node_modules\n.nuxt\n");
  if (withLockfile) {
    await writeFile(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  }
  return root;
}

describe("rebuildable cache inventory", () => {
  it("finds deep Xcode subcaches while retaining archives, symbols and Products", async () => {
    const root = await createRepository();
    await writeFile(resolve(root, ".gitignore"), ".context/\n");
    const dd = ".context/build/release/DerivedData";
    for (const path of [
      `${dd}/Build/Intermediates.noindex/objects`, `${dd}/ModuleCache.noindex/modules`,
      `${dd}/Index.noindex/DataStore`, `${dd}/Build/Products/App.app`,
      ".context/build/Release.xcarchive/Products", ".context/build/Release.dSYM/Contents",
      ".context/build/QA.xcresult/Data", ".context/build/nested/node_modules/pkg",
    ]) await mkdir(resolve(root, path), { recursive: true });
    await writeFile(resolve(root, dd, "info.plist"), "<dict><key>WorkspacePath</key><string>/project/App.xcworkspace</string></dict>");
    await writeFile(resolve(root, ".context/build/Release.ipa"), "signed release");
    await writeFile(resolve(root, ".context/build/nested/.git"), "gitdir: /other/git");

    const result = await inventoryRebuildableCaches(root);
    expect(result.map(c => c.relativePath).sort()).toEqual([
      `${dd}/Build/Intermediates.noindex`, `${dd}/Index.noindex`, `${dd}/ModuleCache.noindex`,
    ]);
  });

  it("rejects misleading cache names, symlinks and tracked files in ignored directories", async () => {
    const root = await createRepository();
    await writeFile(resolve(root, ".gitignore"), ".context/\nModuleCache.noindex/\n.next/\n");
    await mkdir(resolve(root, "ModuleCache.noindex"));
    await mkdir(resolve(root, ".next"));
    await writeFile(resolve(root, ".next/source.ts"), "valuable tracked source");
    await execFileAsync("git", ["-C", root, "add", "--force", ".next/source.ts"]);
    const dd = resolve(root, ".context/native-build");
    await mkdir(dd, {recursive: true});
    await writeFile(resolve(dd, "info.plist"), "<key>WorkspacePath</key><string>/project/App.xcodeproj</string>");
    await symlink(resolve(root, "ModuleCache.noindex"), resolve(dd, "ModuleCache.noindex"));
    expect(await inventoryRebuildableCaches(root)).toEqual([]);
  });

  it("includes only known, Git-ignored, reproducible directories", async () => {
    const root = await createRepository();
    await mkdir(resolve(root, "node_modules", "package"), { recursive: true });
    await mkdir(resolve(root, ".nuxt", "dist"), { recursive: true });
    await mkdir(resolve(root, "dist"), { recursive: true });
    await writeFile(resolve(root, "node_modules", "package", "index.js"), "fixture\n");
    await writeFile(resolve(root, ".nuxt", "dist", "app.js"), "fixture\n");
    await writeFile(resolve(root, "dist", "release.js"), "do not classify\n");

    const result = await inventoryRebuildableCaches(root);

    expect(result.map((cache) => cache.relativePath).sort()).toEqual([
      ".nuxt",
      "node_modules",
    ]);
    expect(result.every((cache) => cache.ignoredByGit)).toBe(true);
    expect(result.every((cache) => (cache.sizeBytes ?? 0) > 0)).toBe(true);
  });

  it("does not call node_modules reproducible without a lockfile", async () => {
    const root = await createRepository(false);
    await mkdir(resolve(root, "node_modules", "package"), { recursive: true });

    const result = await inventoryRebuildableCaches(root);

    expect(result).toEqual([]);
  });

  it("does not attribute a nested worktree cache to its parent repository", async () => {
    const root = await createRepository();
    await writeFile(resolve(root, ".gitignore"), "node_modules\n.worktrees\n");
    await mkdir(resolve(root, "node_modules", "parent-package"), { recursive: true });
    await mkdir(resolve(root, ".worktrees", "agent", "node_modules", "child-package"), {
      recursive: true,
    });
    await writeFile(resolve(root, ".worktrees", "agent", ".git"), "gitdir: /tmp/agent\n");

    const result = await inventoryRebuildableCaches(root);

    expect(result.map((cache) => cache.relativePath)).toEqual(["node_modules"]);
  });

  it("finds tool-owned caches across ecosystems when their manifests prove ownership", async () => {
    const root = await createRepository(false);
    await writeFile(
      resolve(root, ".gitignore"),
      "target/\n.venv/\n.build/\nPods/\n.gradle/\n.dart_tool/\n",
    );
    const files: Record<string, string> = {
      "Cargo.toml": "[package]\nname = \"fixture\"\n",
      "target/.rustc_info.json": "{}",
      "target/debug/deps/fixture.dSYM/Contents/Info.plist": "rebuildable symbols",
      "target/debug/build/fixture-1/out/generated.rs": "// generated",
      "pyproject.toml": "[project]\nname = \"fixture\"\n",
      ".venv/pyvenv.cfg": "home = /usr/bin\n",
      ".venv/lib/site.py": "# installed",
      "Package.swift": "// swift-tools-version:5.9\n",
      ".build/debug/App": "binary",
      "Podfile.lock": "PODS: []\n",
      "Pods/Manifest.lock": "PODS: []\n",
      "settings.gradle.kts": "rootProject.name = \"fixture\"\n",
      ".gradle/8.0/fileHashes.bin": "cache",
      "pubspec.yaml": "name: fixture\n",
      ".dart_tool/package_config.json": "{}",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(resolve(root, path, ".."), { recursive: true });
      await writeFile(resolve(root, path), content);
    }

    const result = await inventoryRebuildableCaches(root);

    expect(result.map((cache) => cache.relativePath).sort()).toEqual([
      ".build",
      ".dart_tool",
      ".gradle",
      ".venv",
      "Pods",
      "target",
    ]);
    expect(result.find((cache) => cache.relativePath === "target")?.name).toBe(
      "Rust build output",
    );
  });

  it("does not trust common directory names without their tool's proof", async () => {
    const root = await createRepository(false);
    await writeFile(
      resolve(root, ".gitignore"),
      "target/\nvenv/\n.venv/\n.build/\nPods/\n.gradle/\n.dart_tool/\n",
    );
    const files: Record<string, string> = {
      // Cargo.toml without a Cargo marker inside target, e.g. a Maven target.
      "Cargo.toml": "[package]\nname = \"fixture\"\n",
      "target/classes/App.class": "compiled",
      // A virtual environment marker without any Python manifest beside it.
      "tools/venv/pyvenv.cfg": "home = /usr/bin\n",
      // A Python manifest next to a directory that is not a virtual environment.
      "requirements-dev.txt": "pytest\n",
      ".venv/notes.md": "not an environment",
      ".build/output.bin": "no Package.swift",
      "Pods/Manifest.lock": "no Podfile.lock",
      ".gradle/cache.bin": "no Gradle build file",
      ".dart_tool/package_config.json": "no pubspec",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(resolve(root, path, ".."), { recursive: true });
      await writeFile(resolve(root, path), content);
    }

    expect(await inventoryRebuildableCaches(root)).toEqual([]);
  });
});

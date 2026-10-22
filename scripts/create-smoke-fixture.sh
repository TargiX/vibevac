#!/usr/bin/env bash
# Creates a scan root with one Git repository that holds a lockfile and an
# ignored node_modules, the smallest fixture both engines must report.
set -euo pipefail

root="${1:?usage: create-smoke-fixture.sh <empty directory>}"
repository="$root/smoke-app"
mkdir -p "$repository/node_modules/left-pad"
cd "$repository"
git init -q
printf 'node_modules/\n' > .gitignore
printf '{ "name": "smoke-app", "private": true }\n' > package.json
printf '{ "name": "smoke-app", "lockfileVersion": 3, "packages": {} }\n' > package-lock.json
printf 'module.exports = () => {};\n' > node_modules/left-pad/index.js
git add .gitignore package.json package-lock.json
git -c user.name=VibeVac -c user.email=smoke@vibevac.invalid commit -q -m "Smoke fixture"

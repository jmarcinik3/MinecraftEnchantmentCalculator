#!/usr/bin/env bash
# Dry run of .github/stamp-version.sh on a temporary copy of the site, so a reference the
# script can't find (a renamed file, a new import it would miss) fails here, on every push
# and pull request, instead of only when main is deployed.
#
# Run from the project folder:  bash test/Stamp.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

version="abc12345"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
passed=0
ok() { passed=$((passed + 1)); echo "  ok  $1"; }
fail() { echo "  FAIL $1" >&2; exit 1; }

copy_site() { # the same files the deploy job copies (see .github/workflows/pages.yml)
    rm -rf "$1" && mkdir -p "$1"
    cp -r index.html ServiceWorker.js manifest.webmanifest css js json img font "$1"/
}

site="$work/site"
copy_site "$site"
bash .github/stamp-version.sh "$site" "$version" > "$work/out.txt" || fail "the script failed on the current site: $(cat "$work/out.txt")"
ok "the script stamps the current site"

grep -qF "href=\"css/Style.css?v=$version\"" "$site/index.html" && grep -qF "src=\"js/App.js?v=$version\"" "$site/index.html" || fail "index.html references are not stamped"
ok "index.html's stylesheet and script are stamped"

unstamped=$(grep -nE "from \"\./[A-Za-z]+\.js\"" "$site"/js/*.js | grep -v "/Engine.js:\|/Calculator.js:" || true)
[ -z "$unstamped" ] || fail "module imports left unstamped: $unstamped"
ok "every module import is stamped"

grep -qF "const VERSION = \"$version\"" "$site/ServiceWorker.js" || fail "the worker's VERSION is not stamped"
grep -qF "const MODS_VERSION = \"?v=$version\"" "$site/js/App.js" && grep -qF "const TEXT_VERSION = \"?v=$version\"" "$site/js/Text.js" || fail "the data versions are not stamped"
ok "the worker's version and the data versions are stamped"

# The source files themselves are never touched.
grep -qF 'const VERSION = "dev"' ServiceWorker.js || fail "the repository's ServiceWorker.js was changed"
ok "the repository is left alone"

# Every ES module the page can reach stays an import the script understands: the files in js/ all appear in the worker's list.
for file in js/*.js; do grep -qF "\"$file\"" ServiceWorker.js || fail "$file is not in ServiceWorker.js FILES"; done
ok "every script is in the worker's file list"

# A reference the script can't find must fail it (so the check above really guards the deploy).
broken="$work/broken"
copy_site "$broken"
sed -i 's#importScripts("Engine.js")#importScripts("EngineRenamed.js")#' "$broken/js/Calculator.js"
if bash .github/stamp-version.sh "$broken" "$version" > /dev/null 2>&1; then fail "a missing reference did not fail the script"; fi
ok "a missing reference fails the script"

echo "$passed passed"

#!/usr/bin/env bash
# Adds ?v=<version> to the page's references to its own code and data, in the copy of
# the site being deployed (not in the repository). Browsers, phones especially, keep
# cached copies of each file; a new address per release makes them load the new code
# instead of mixing old and new files. Fails if a reference is missing, so renaming a
# file cannot silently turn this off.
#
# Usage: .github/stamp-version.sh <site folder> <version>
set -euo pipefail
site="$1"
version="$2"

stamp() { # file, exact text, text with the version added
    if ! grep -qF -- "$2" "$site/$1"; then
        echo "::error::stamp-version: '$2' not found in $1" >&2
        exit 1
    fi
    # Literal (not regex) replace: escape the characters sed treats specially.
    local find replace
    find=$(printf '%s' "$2" | sed 's/[][\.*^$|/]/\\&/g')
    replace=$(printf '%s' "$3" | sed 's/[&|/\\]/\\&/g')
    sed -i "s/$find/$replace/g" "$site/$1"
}

stamp index.html 'href="css/Style.css"' "href=\"css/Style.css?v=$version\""
stamp index.html 'src="js/App.js"' "src=\"js/App.js?v=$version\""
stamp js/App.js 'from "./Logic.js"' "from \"./Logic.js?v=$version\""
stamp js/App.js 'from "./Text.js"' "from \"./Text.js?v=$version\""
stamp js/App.js '"js/Calculator.js"' "\"js/Calculator.js?v=$version\""
stamp js/App.js '"json/metadata.json"' "\"json/metadata.json?v=$version\""
stamp js/Calculator.js 'importScripts("Engine.js")' "importScripts(\"Engine.js?v=$version\")"
stamp js/Text.js 'from "./TextSpanish.js"' "from \"./TextSpanish.js?v=$version\""
# The offline copy: its file list gets the same addresses, and each release a new cache.
stamp ServiceWorker.js 'const VERSION = "dev"' "const VERSION = \"$version\""
echo "Stamped site files with version $version"

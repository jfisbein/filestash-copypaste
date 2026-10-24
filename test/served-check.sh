#!/bin/bash
# Is everything the plugin relies on still in what this Filestash serves? Run it after every
# Filestash update. It needs no login.
#   test/served-check.sh http://localhost:8334/
# Checks: the patch applied (module and bundle), the plugin files served, the exports copy.js
# imports, and the classes, attributes and API shapes it mirrors. Exit code = number of failures.
B=${1:?usage: served-check.sh <filestash-url>}
B=${B%/}
fail=0
ok()  { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; fail=$((fail + 1)); }
has() { # has <file> <fixed string> <label>
    if grep -qF -- "$2" "$T/$1"; then ok "$3"; else bad "$3  (\"$2\" not in $1)"; fi
}
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

for i in $(seq 1 15); do # right after a restart Filestash takes a few seconds
    curl -fsS "$B/" -o "$T/index.html" 2>/dev/null && break
    sleep 2
done
[ -s "$T/index.html" ] || { bad "$B/ does not answer"; exit 1; }
ref=$(grep -o '/assets/[0-9a-f]\{40\}/' "$T/index.html" | head -1)
echo "build ref $ref"
[ -n "$ref" ] || { bad "no build ref in the index page"; exit 1; }

get() { curl -s -o "$T/$2" -w '%{http_code}' "$B$ref$1"; }
for f in pages/filespage/ctrl_submenu.js:ctrl_submenu.js pages/filespage/state_selection.js:state_selection.js \
         pages/filespage/helper.js:helper.js pages/filespage/model_files.js:model_files.js pages/filespage/thing.js:thing.js \
         components/notification.js:notification.js components/sidebar_files.js:sidebar_files.js components/breadcrumb.js:breadcrumb.js \
         locales/index.js:locales_index.js; do
    code=$(get "${f%%:*}" "${f##*:}")
    [ "$code" = 200 ] || bad "${f%%:*} HTTP $code"
done

# 1. the patch applied, and the files it loads are served
line1=$(head -1 "$T/ctrl_submenu.js")
v=$(grep -o 'copy.js?v=[0-9a-f]*' <<<"$line1" | cut -d= -f2)
[[ "$line1" == import\(new\ URL\(\"../../plugin/copypaste.zip/copy.js* ]] && ok "patch applied to ctrl_submenu.js (v=$v)" || bad "patch NOT applied (line 1: ${line1:0:80})"
bundle=$(grep -o 'bundle.js?version=[^"&]*' "$T/index.html" | head -1)
n=0; for c in 1 2 3 4 5 6 7 8 9 10; do
    curl -s "$B/assets/$bundle&chunk=$c" | grep -q "copypaste.zip/copy.js?v=$v" && { ok "patch in bundle chunk $c"; n=1; break; }
done
[ $n = 1 ] || bad "patch not found in any bundle chunk (the bundle URL scheme may have changed)"
for m in copy.js engine.js i18n.js; do
    r=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$B${ref}plugin/copypaste.zip/$m?v=$v")
    [[ "$r" == "200 application/javascript"* ]] && ok "plugin $m served" || bad "plugin $m: $r"
done
for l in en es; do
    r=$(curl -s -o "$T/$l.json" -w '%{http_code}' "$B${ref}plugin/copypaste.zip/locales/$l.json?v=$v")
    [ "$r" = 200 ] && grep -q '"COPY"' "$T/$l.json" && ok "plugin locales/$l.json served" || bad "plugin locales/$l.json: HTTP $r"
done

# 2. what copy.js imports
for name in 'getSelection$' expandSelection lengthSelection clearSelection; do
    { grep -qF "export function $name(" "$T/state_selection.js" || grep -qF "export const $name =" "$T/state_selection.js"; } \
        && ok "state_selection.js exports $name" || bad "state_selection.js no longer exports $name"
done
grep -qE 'export (function|const) currentPath\b' "$T/helper.js" && ok "helper.js exports currentPath" || bad "helper.js no longer exports currentPath"
grep -qE 'export (function|const) refresh\b' "$T/model_files.js" && ok "model_files.js exports refresh" || bad "model_files.js no longer exports refresh"
grep -q 'export default' "$T/notification.js" && ok "notification.js has a default export" || bad "notification.js has no default export"

# 3. the DOM and API shapes copy.js and the drop handler mirror, and the language rule i18n.js copies
has ctrl_submenu.js  'class="component_submenu'      "toolbar .component_submenu"
has ctrl_submenu.js  'class="action left'            "toolbar .action.left"
has thing.js         'class="component_thing'        "list item .component_thing"
has thing.js         '"data-path"'                   "list item data-path"
has thing.js         '"data-droptarget"'             "list item data-droptarget"
has thing.js         'setData("path"'                "drag carries dataTransfer \"path\""
has sidebar_files.js '<li data-path='                "sidebar li[data-path]"
has breadcrumb.js    'component_path-element n'      "breadcrumb .component_path-element"
has breadcrumb.js    'data-path='                    "breadcrumb data-path"
has breadcrumb.js    '<a class="label"'              "breadcrumb a.label"
has model_files.js   'api/files/mv?from='            "mv API: ?from=&to="
has locales_index.js 'navigator.language'            "Filestash picks its language from navigator.language"
langs() { grep -o '"[a-z]\{2\}"' | grep -vx '"en"' | sort -u | tr -d '"' | tr '\n' ' '; }
ours=$(curl -s "$B${ref}plugin/copypaste.zip/i18n.js?v=$v" | langs) # the plugin as served
upstream=$(langs < "$T/locales_index.js")
[ "$ours" = "$upstream" ] && ok "Filestash's languages are the ones i18n.js lists ($(wc -w <<<"$ours") + regional)" \
    || bad "Filestash's languages changed: upstream [$upstream], i18n.js [$ours]"
grep -qF '"zh-TW"' "$T/locales_index.js" && grep -qF '"fr-CA"' "$T/locales_index.js" && ok "Filestash's regional languages are zh-TW and fr-CA" \
    || bad "Filestash's regional languages changed"

echo
[ $fail = 0 ] && echo "ALL PASSED" || echo "$fail FAILED"
exit $fail

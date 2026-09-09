#!/usr/bin/env bash
# test-install-shadow-source.sh
#
# install.sh writes ONE bare copy at ~/.claude/skills/co-dialectic/ — the
# naming-collision workaround, because the plugin system will not register a
# skill whose name matches its plugin. Everything else comes from the plugin.
#
# The bug: that copy was fetched from remote `main`, not from the plugin that
# had just been installed. Remote main and the marketplace-vendored version are
# two different artifacts, so they can disagree at install time. Observed
# 2026-08-17 on a live machine: bare copy 4.38.0, installed plugin 4.41.1.
#
# A bare copy SHADOWS the plugin — Claude Code loads it for the unscoped name,
# so the plugin's copy never runs, while the version banner keeps reporting the
# plugin it RESOLVED. The drift is invisible by construction.
#
# These tests exercise the helpers directly against a fake HOME. They never run
# the installer end-to-end (it prompts, curls, and writes to the real ~/.claude).

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_SH="$ROOT/install.sh"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ok   $1"; }
bad() { fail=$((fail+1)); echo "  FAIL $1${2:+ — $2}"; }

echo ""
echo "install.sh — bare copy must come from the installed plugin"
echo ""

extract_fn() { sed -n "/^$1()/,/^}/p" "$INSTALL_SH"; }

for fn in plugin_skill_source assert_skill_version_matches prune_plugin_skill_shadows; do
  if [ -n "$(extract_fn "$fn")" ]; then ok "helper $fn() exists"
  else bad "helper $fn() exists" "not found in install.sh"; fi
done

mkfixture() {
  FAKE="$(mktemp -d)"
  for v in 4.9.0 4.41.1 4.40.0; do
    mkdir -p "$FAKE/.claude/plugins/cache/xos/co-dialectic/$v/skills/co-dialectic"
    mkdir -p "$FAKE/.claude/plugins/cache/xos/co-dialectic/$v/.claude-plugin"
    printf -- '---\nname: co-dialectic\n---\n**Version:** %s\n' "$v" \
      > "$FAKE/.claude/plugins/cache/xos/co-dialectic/$v/skills/co-dialectic/SKILL.md"
    printf '{"name":"co-dialectic","version":"%s"}\n' "$v" \
      > "$FAKE/.claude/plugins/cache/xos/co-dialectic/$v/.claude-plugin/plugin.json"
  done
  for s in handoff waky-waky judge-panel; do
    mkdir -p "$FAKE/.claude/plugins/cache/xos/co-dialectic/4.41.1/skills/$s"
    printf 'fresh %s\n' "$s" > "$FAKE/.claude/plugins/cache/xos/co-dialectic/4.41.1/skills/$s/SKILL.md"
  done
  mkdir -p "$FAKE/.claude/skills"
}

# Load ALL the helpers, not just the one under test — prune_plugin_skill_shadows
# calls plugin_skill_source, and a harness that omits the dependency makes the
# function return early and the assertion fail for a reason that has nothing to
# do with the code being tested.
call_fn() {
  local fn="$1"; shift
  HOME="$FAKE" bash -c '
    set -uo pipefail
    for h in plugin_skill_source assert_skill_version_matches prune_plugin_skill_shadows; do
      eval "$(sed -n "/^$h()/,/^}/p" "$1")"
    done
    fn="$2"; shift 2
    "$fn" "$@"
  ' _ "$INSTALL_SH" "$fn" "$@" 2>&1
}

# ── 1. newest version wins, in VERSION order not lexical ────────────────────
mkfixture
OUT="$(call_fn plugin_skill_source xos co-dialectic co-dialectic)"; RC=$?
if [ "$RC" -eq 0 ] && [ -n "$OUT" ]; then
  case "$OUT" in
    *4.41.1*) ok "resolves the newest installed version (4.41.1)" ;;
    *)        bad "resolves the newest installed version" "got: $OUT" ;;
  esac
else
  bad "plugin_skill_source returns a path" "rc=$RC out=$OUT"
fi

# The lexical trap: "4.9.0" > "4.41.1" as strings. Picking 4.9.0 would DOWNGRADE
# the bare copy on every install.
case "${OUT:-}" in
  *4.9.0*) bad "version-order sort (not lexical)" "picked 4.9.0 over 4.41.1" ;;
  *)       ok "version-order sort (not lexical)" ;;
esac

# ── 2. missing cache handled, not fatal ─────────────────────────────────────
OUT="$(call_fn plugin_skill_source xos does-not-exist co-dialectic)"; RC=$?
if [ "$RC" -ne 0 ] || [ -z "$OUT" ]; then
  ok "absent plugin cache returns non-zero (remote fallback still possible)"
else
  bad "absent plugin cache handled" "returned: $OUT"
fi

# ── 3. skew warning fires and names BOTH versions ───────────────────────────
mkfixture
mkdir -p "$FAKE/.claude/skills/co-dialectic"
printf -- '**Version:** 4.38.0\n' > "$FAKE/.claude/skills/co-dialectic/SKILL.md"
OUT="$(call_fn assert_skill_version_matches "$FAKE/.claude/skills/co-dialectic/SKILL.md" \
        "$FAKE/.claude/plugins/cache/xos/co-dialectic/4.41.1/.claude-plugin/plugin.json")"
if [ "${OUT#*4.38.0}" != "$OUT" ] && [ "${OUT#*4.41.1}" != "$OUT" ]; then
  ok "skew warning names BOTH versions"
else
  bad "skew warning names both versions" "got: ${OUT:-<empty>}"
fi

# ── 4. silent when they agree (a gate that always fires is noise) ───────────
printf -- '**Version:** 4.41.1\n' > "$FAKE/.claude/skills/co-dialectic/SKILL.md"
OUT="$(call_fn assert_skill_version_matches "$FAKE/.claude/skills/co-dialectic/SKILL.md" \
        "$FAKE/.claude/plugins/cache/xos/co-dialectic/4.41.1/.claude-plugin/plugin.json")"
if [ -z "$(printf '%s' "$OUT" | tr -d '[:space:]')" ]; then
  ok "matching versions are silent"
else
  bad "matching versions are silent" "got: $OUT"
fi

# ── 5. unreadable inputs stay silent (absence of evidence ≠ skew) ───────────
OUT="$(call_fn assert_skill_version_matches "$FAKE/nope/SKILL.md" "$FAKE/nope/plugin.json")"
if [ -z "$(printf '%s' "$OUT" | tr -d '[:space:]')" ]; then
  ok "unreadable inputs produce no false skew warning"
else
  bad "unreadable inputs silent" "got: $OUT"
fi

# ── 6. prune moves EVERY shadow, keeps the naming-collision copy ────────────
# The ((var++)) / set -e trap pruned exactly one per run, so use three.
mkfixture
for s in handoff waky-waky judge-panel co-dialectic; do
  mkdir -p "$FAKE/.claude/skills/$s"; printf 'STALE %s\n' "$s" > "$FAKE/.claude/skills/$s/SKILL.md"
done
mkdir -p "$FAKE/.claude/skills/other-vendor"; printf 'keep me\n' > "$FAKE/.claude/skills/other-vendor/SKILL.md"
call_fn prune_plugin_skill_shadows xos co-dialectic co-dialectic >/dev/null

LEFT=""
for s in handoff waky-waky judge-panel; do [ -d "$FAKE/.claude/skills/$s" ] && LEFT="$LEFT $s"; done
if [ -z "$LEFT" ]; then ok "every shadow pruned (3/3) — not just the first"
else bad "every shadow pruned" "still present:$LEFT"; fi

if [ -d "$FAKE/.claude/skills/co-dialectic" ]; then ok "naming-collision copy kept"
else bad "naming-collision copy kept" "pruned the entry point"; fi

if [ -f "$FAKE/.claude/skills/other-vendor/SKILL.md" ]; then ok "other vendors' skills untouched"
else bad "other vendors' skills untouched" "prune reached outside the plugin's skill set"; fi

FOUND="$(find "$FAKE/.claude/skills" -type d -name waky-waky -path '*_shadowed*' 2>/dev/null | head -1)"
if [ -n "$FOUND" ] && grep -q 'STALE waky-waky' "$FOUND/SKILL.md" 2>/dev/null; then
  ok "shadows quarantined with content intact, not deleted"
else
  bad "shadows quarantined" "no recoverable copy found"
fi

call_fn prune_plugin_skill_shadows xos co-dialectic co-dialectic >/dev/null
if [ -d "$FAKE/.claude/skills/co-dialectic" ]; then ok "second prune is a no-op"
else bad "second prune is a no-op"; fi

# ── 7. portability + the set -e increment trap ──────────────────────────────
if bash -n "$INSTALL_SH" 2>/dev/null; then ok "install.sh parses"
else bad "install.sh parses" "$(bash -n "$INSTALL_SH" 2>&1 | head -2)"; fi

if grep -nE '\(\([a-zA-Z_]+\+\+\)\)' "$INSTALL_SH" >/dev/null 2>&1; then
  bad "no ((var++)) under set -e" "$(grep -nE '\(\([a-zA-Z_]+\+\+\)\)' "$INSTALL_SH" | head -2)"
else
  ok "no ((var++)) — returns 1 when var is 0 and aborts under set -e"
fi

if grep -nE 'mapfile|declare -A' "$INSTALL_SH" >/dev/null 2>&1; then
  bad "bash 3.2 safe" "$(grep -nE 'mapfile|declare -A' "$INSTALL_SH" | head -1)"
else
  ok "bash 3.2 safe (no mapfile / declare -A)"
fi

# ── 8. the plugin-success path must source from the plugin, not remote ──────
# Anchor on the marketplace add, not on a literal install address — the address
# is now derived at runtime, and anchoring on it made these assertions silently
# scan an EMPTY block the moment the address changed.
BLOCK="$(sed -n '/marketplace add "\$MARKETPLACE_REPO"/,/_use_direct=false/p' "$INSTALL_SH")"

# Grep for the CALL, not the name. A mutation that replaced the call with
# `if false; then` left the variable `_plugin_skill_source` in place, so an
# assertion matching the bare token passed while the behaviour was gone —
# the mutation run caught this assertion being vacuous.
case "$BLOCK" in
  *'$(plugin_skill_source '*) ok "plugin-success path CALLS plugin_skill_source" ;;
  *)                          bad "plugin-success path calls plugin_skill_source" "call removed — remote-only again" ;;
esac

# And the resolved path must actually be copied into the bare skill dir.
case "$BLOCK" in
  *'cp "$_plugin_skill_source"'*) ok "resolved plugin path is copied to the bare skill dir" ;;
  *)                              bad "resolved plugin path is copied" "no cp from the resolved source" ;;
esac
case "$BLOCK" in
  *prune_plugin_skill_shadows*) ok "plugin-success path prunes pre-existing shadows" ;;
  *)                            bad "plugin-success path prunes shadows" "not called" ;;
esac

# ── 9. distribution goes through the xOS gateway ────────────────────────────
# Co-Dialectic's SOURCE lives in this repo (AGPL, public, forkable). Its
# DISTRIBUTION goes through Exponential-OS/agent-marketplace, so every install is a
# doorway to the other engines. Source != distribution.
#
# The earlier arrangement shipped it from BOTH marketplaces at once, which produced
# co-dialectic@thewhyman 4.43.0 beside co-dialectic@xos 4.41.1 on one machine within
# the hour. One plugin, one distribution address.
case "$(grep -c 'MARKETPLACE_REPO="Exponential-OS/agent-marketplace"' "$INSTALL_SH")" in
  0) bad "installer points at the xOS gateway" "MARKETPLACE_REPO is not agent-marketplace" ;;
  *) ok "installer points at the xOS gateway" ;;
esac

# The address is still DERIVED from the gateway's own manifest, never hardcoded — a
# literal suffix is what silently stops matching after a marketplace rename.
BLOCK2="$(sed -n '/marketplace add "\$MARKETPLACE_REPO"/,/_use_direct=false/p' "$INSTALL_SH")"
case "$BLOCK2" in
  *'plugin_skill_source "$_marketplace_name"'*) ok "resolved name flows into plugin_skill_source" ;;
  *) bad "resolved name flows into plugin_skill_source" "hardcoded again" ;;
esac
case "$BLOCK2" in
  *'prune_plugin_skill_shadows "$_marketplace_name"'*) ok "resolved name flows into prune_plugin_skill_shadows" ;;
  *) bad "resolved name flows into prune" "hardcoded again" ;;
esac

if grep -q 'MARKETPLACE_RAW/.claude-plugin/marketplace.json' "$INSTALL_SH"; then
  ok "name resolved from the GATEWAY manifest, not this repo's"
else
  bad "name resolved from the gateway manifest" "still fetching this repo's manifest"
fi

# ── 10. this repo's manifest is for TESTING, not distribution ────────────────
# Deleting it entirely was the first instinct, but test-plugin.sh --smoke-install
# registers this repo as a local marketplace to prove the plugin actually installs.
# Losing that check risks shipping a plugin that cannot be installed — worse than the
# dual-add it was meant to prevent. So the manifest stays, install.sh is the single
# thing that names the distribution channel, and the manifest says so out loud.
if [ -f "$ROOT/.claude-plugin/marketplace.json" ]; then
  ok "local manifest retained (install smoke test depends on it)"
  NOTE=$(python3 -c "import json;print(json.load(open('$ROOT/.claude-plugin/marketplace.json')).get('metadata',{}).get('distribution_note',''))" 2>/dev/null)
  case "$NOTE" in
    *"NOT the distribution channel"*) ok "manifest declares it is not the install address" ;;
    *) bad "manifest declares it is not the install address" "distribution_note missing" ;;
  esac
  LIC=$(python3 -c "import json;print([p.get('license') for p in json.load(open('$ROOT/.claude-plugin/marketplace.json'))['plugins'] if p['name']=='co-dialectic'][0])" 2>/dev/null)
  if [ "$LIC" = "AGPL-3.0" ]; then ok "local manifest declares AGPL-3.0"
  else bad "local manifest declares AGPL-3.0" "got '${LIC:-<none>}'"; fi
else
  bad "local manifest retained" "deleted — the install smoke test cannot run"
fi

# ── 11. the license is declared, and it is the one LICENSE actually grants ───
# The public catalog listed co-dialectic as "Proprietary" while LICENSE grants AGPL-3.0,
# and plugin.json/package.json declared nothing. A public catalog mislabelling an AGPL
# project is a trust problem, and it undercuts the open-source positioning that makes
# this the top of the funnel in the first place.
if head -3 "$ROOT/LICENSE" 2>/dev/null | grep -qi "AFFERO"; then
  ok "LICENSE grants AGPL"
else
  bad "LICENSE grants AGPL" "unexpected LICENSE content"
fi
for f in "plugins/co-dialectic/.claude-plugin/plugin.json" "plugins/co-dialectic/package.json"; do
  DECL=$(python3 -c "import json;print(json.load(open('$ROOT/$f')).get('license',''))" 2>/dev/null)
  if [ "$DECL" = "AGPL-3.0" ]; then ok "$f declares AGPL-3.0"
  else bad "$f declares AGPL-3.0" "got '${DECL:-<none>}'"; fi
done

rm -rf "${FAKE:-/nonexistent}"
echo ""
echo "  ${pass} passed, ${fail} failed"
echo ""
[ "$fail" -eq 0 ]

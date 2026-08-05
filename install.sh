#!/usr/bin/env bash
#
# Install (by symlink) the repo-local Renode syntax extension into your editor.
#
# VS Code has no mechanism for loading an extension out of a workspace folder — it only
# scans <editor>/extensions. So the extension SOURCE lives here, versioned and reviewed
# with the rest of the repo, and this script links it into place. A symlink rather than a
# copy, so a `git pull` that improves a grammar takes effect on the next window reload
# instead of needing a re-install.
#
#   ./install.sh              link it
#   ./install.sh --uninstall  remove the link
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="farmblox.renode"
EXT_DIRS=(
    "$HOME/.vscode/extensions"
    "$HOME/.vscode-insiders/extensions"
    "$HOME/.vscode-server/extensions"
    "$HOME/.cursor/extensions"
    "$HOME/.windsurf/extensions"
)

uninstall=0
[ "${1:-}" = "--uninstall" ] && uninstall=1

touched=0
already=0
for dir in "${EXT_DIRS[@]}"; do
    [ -d "$dir" ] || continue
    target="$dir/$NAME"
    if [ "$uninstall" -eq 1 ]; then
        if [ -L "$target" ]; then
            rm "$target"
            echo "removed  $target"
            touched=$((touched + 1))
        fi
        continue
    fi
    # Already correct? Say so and leave it alone. This runs on every folder open (see
    # .vscode/tasks.json), so re-linking each time would be pure churn and noise.
    if [ -L "$target" ] && [ "$(readlink "$target")" = "$HERE" ]; then
        echo "ok       $target already linked"
        touched=$((touched + 1))
        already=$((already + 1))
        continue
    fi
    # Only ever replace OUR OWN symlink: a real directory there is somebody else's
    # extension, or a copy someone made on purpose, and is not ours to remove.
    if [ -L "$target" ]; then
        rm "$target"
    elif [ -e "$target" ]; then
        echo "skip     $target already exists and is not a symlink" >&2
        continue
    fi
    ln -s "$HERE" "$target"
    echo "linked   $target -> $HERE"
    touched=$((touched + 1))
done

if [ "$touched" -eq 0 ]; then
    if [ "$uninstall" -eq 1 ]; then
        echo "nothing to remove."
        exit 0
    fi
    echo "no editor extensions directory found. Looked in:" >&2
    printf '  %s\n' "${EXT_DIRS[@]}" >&2
    exit 1
fi

if [ "$uninstall" -eq 1 ]; then
    echo
    echo "Reload the editor window to drop the grammars."
elif [ "$already" -lt "$touched" ]; then
    # Something was newly linked. Extensions are scanned at startup, so the grammars are
    # not live in THIS window yet — only after a reload.
    echo
    echo "Now run 'Developer: Reload Window' and open a .repl or .resc file."
fi

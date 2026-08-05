# Renode for VS Code

Language support for [Renode](https://renode.io)'s two file formats — platform descriptions
(`.repl`) and Monitor scripts (`.resc`) — with syntax highlighting, hovers, document links and
go-to-definition.

[![test](https://github.com/farmblox/vscode-renode/actions/workflows/test.yml/badge.svg)](https://github.com/farmblox/vscode-renode/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Renode files are a graph pretending to be a list. A board description `using`s a SoC
description; a script sets a variable and `include`s another script that consumes it; an
attribute name is really a C# constructor parameter; and a bare word like `medium` was invented
three files ago. This extension reads that graph so you don't have to hold it in your head.

**It is built to the language, not to one project.** Every rule follows Renode's own
references, and the contract is pinned by the fixtures in [`fixtures/`](fixtures) — a SoC
description, a board overlay, three scripts and a C# model that between them exercise the
documented syntax directly.

---

## Features

### Everything that names a file becomes a link

`include`/`i`, `using "…"`, the whole `Load*` family (`LoadPlatformDescription`, `LoadBinary`,
`LoadELF`, `LoadHEX`, `LoadUImage`, `LoadFdt`, `LoadAtags`, `LoadSymbolsFrom`), `path add`,
`resd`, `displayImage`, and the output paths `logFile`, `CreateFileBackend`, `Save`, `autoSave`.
Ctrl/⌘-click or <kbd>F12</kbd> opens the target.

Hovering a path says where it resolves **and what is there** — a script's `:name:` and
`:description:`, or a `.repl`/`.cs`/`.py` file's leading comment block:

```
include $ORIGIN/platform/board.resc
        ╰─ platform/board.resc
           nucleo_wl55jc — brings up the SoC, seeds the OTP identity, wires the radio.
```

A path that resolves to nothing says so — **unless the command writes it**, in which case it is
reported as an output rather than as an error.

### Hovers that explain the vocabulary

Monitor commands, built-in objects and `.repl` format keywords are documented in place. The same
word can be either, and is described correctly for the file it is in: `using` is a format
keyword in a `.repl` and a Monitor command in a `.resc`.

`emulation`, `machine`, `sysbus` and `connector` are **objects** in the Monitor's tree, not
commands — so `sysbus LoadBinary @img.bin 0x0` reads as *object* + *method*, and the colours say
so too.

### Members resolved from the model's own C#

This is the part a lookup table cannot do. Custom peripherals are the normal case in Renode, so
members are **parsed out of the model source** in your workspace, doc comment included:

| Where | Example | Resolves to |
|-------|---------|-------------|
| `.repl` attribute | `frequency: 72000000` | the C# property **or constructor parameter** |
| `.repl` wiring | `Alarm -> nvic@3` | the public `GPIO` field |
| `.resc` method on a peripheral | `sysbus.uart0 CreateFileBackend …` | the method on its class |
| `.resc` method on a created name | `medium SetPosition …` | the method, via the factory's file |
| `.resc` custom factory | `emulation CreateThing "x"` | the `this Emulation` extension method |

```
uart0: UART.STM32WL_UART @ sysbus <0x40008000, +0x400>
    lowPowerMode: true
    ╰─ bool lowPowerMode   // constructor parameter of STM32WL_UART
       Selects LPUART-vs-USART semantics within this part.
```

The receiver is resolved first — a node's declared type, or the factory that created the name —
and the member is then looked up in that class. `.repl` attributes are matched
case-insensitively on the first letter, because `frequency:` binds to `Frequency`.

### Nodes, types and variables

- **A node name** shows its declaration, file and line, and the comment block above it — found
  through the `using` chain, so a board overlay resolves names declared in the SoC file. A
  re-opened node (`uart0:` with no type) still resolves to where its *type* is declared.
- **The same works in a script**, for `sysbus.<peripheral>` and bare node names, through
  whichever platform description the script ends up loading.
- **A type** points at the C# model implementing it.
- **A `$variable`** shows its assignment, what it expands to, and whether `?=` makes it an
  overridable default. `$ORIGIN` and `$CWD` explain themselves.

### Go-to-definition

<kbd>F12</kbd> works on all of it: files, nodes, types, C# members and factories.

---

## Requirements

VS Code 1.75 or newer. Nothing else — the extension is plain JavaScript and JSON, with no build
step and nothing bundled.

Member resolution reads C# files from the open workspace. Renode's *bundled* models are not in
your workspace, so for those the hover names the receiver's type and where it is declared
instead of showing a signature.

## Install

Not on the Marketplace. Two ways:

**From a checkout** — tracks `main`, so a `git pull` and a window reload update it:

```sh
git clone https://github.com/farmblox/vscode-renode.git
cd vscode-renode
./install.sh          # then: Developer: Reload Window
```

The script symlinks the checkout into `<editor>/extensions`, where VS Code scans for extensions
(it will not load one from an arbitrary folder). It is idempotent, `--uninstall` removes the
link, and it also finds VS Code Insiders, Cursor and Windsurf.

Because it is idempotent it is safe to run on folder open:

```jsonc
// .vscode/tasks.json, in whichever repo you edit Renode files in
{
  "version": "2.0.0",
  "tasks": [{
    "label": "Install Renode language support",
    "type": "shell",
    "command": "/path/to/vscode-renode/install.sh",
    "runOptions": { "runOn": "folderOpen" },
    "presentation": { "reveal": "silent", "close": true },
    "problemMatcher": []
  }]
}
```

**As a `.vsix`:**

```sh
npx @vscode/vsce package
code --install-extension renode-0.1.0.vsix
```

### Recommended workspace setting

Worth pinning wherever you edit `.repl` files, because it is not cosmetic: the format requires
**spaces only, in multiples of 4**, and one indent level means one brace — so a stray tab
silently changes what a file declares.

```json
{
  "[renode-repl]": {
    "editor.insertSpaces": true,
    "editor.tabSize": 4,
    "editor.detectIndentation": false
  }
}
```

---

## How resolution works

Two details are worth stating, because getting them wrong produces *confidently wrong* hovers
rather than missing ones.

**The include chain is followed.** One script commonly sets `$plat` and includes another that
calls `LoadPlatformDescription $plat`. Looking at a single file finds the call with no value, or
the value with no call — so the platform lookup, the created-name lookup and path resolution all
walk includes, with the caller's variables winning (which is what `?=` means).

**A variable's `$ORIGIN` expands where it was assigned.** `$plat ?= $ORIGIN/board.repl` written
in one script keeps meaning *that* script's directory when the value is consumed inside a script
it includes. Expanding at the point of use silently rebases it to the wrong folder.

Viewed from the included script alone, a caller-supplied variable genuinely cannot resolve. The
hover names the variable the caller sets rather than claiming the path is broken.

Hovers are suppressed inside comments — a `#` comment or a `:description:` line that mentions a
peripheral's name must not pop that peripheral's declaration.

Where the extension stops: an undocumented built-in member is reported by its **receiver**, not
by a guess, and a member the model does not define resolves to nothing at all. Inventing
behaviour would be worse than silence.

## Architecture

| File | Role |
|------|------|
| `syntaxes/*.tmLanguage.json` | TextMate grammars for both formats |
| `language-configuration-*.json` | comments, brackets, auto-closing, indentation |
| `lib.js` | all resolution logic — imports no `vscode`, so it is testable with plain node |
| `extension.js` | thin adapter turning `lib.js` results into VS Code hovers, links and definitions |

The split is deliberate: a bug in the adapter is a wiring bug, and a bug in the logic is caught
by the tests.

## Testing

```sh
npm test                 # both suites
npm run test:hovers      # resolution logic — no dependencies at all
npm run test:grammars    # grammars, through the real TextMate engine
```

Both assert against `fixtures/` first — the language contract — then sweep every other
`.repl`/`.resc` in the checkout. `check-grammars.mjs` runs `vscode-textmate` and
`vscode-oniguruma`, the same engine VS Code tokenizes with, so a passing assertion is a real one
rather than a guess about how a regex behaves. `check-hovers.mjs` additionally asserts that
**every** file reference resolves to something that exists, is a declared output, or is
correctly identified as caller-supplied.

Eyeballing a grammar does not work, and the suites exist because of what they caught: wiring
whose source is a GPIO pin *number* (`1 -> led@0`), silently skipped by an identifier-only
capture; a missing `showAnalyzer`; hovers firing inside comments; names containing a hyphen split
in two; `path add` targeting a directory rather than a file; output paths reported as missing;
`.repl` attributes that bind to constructor parameters rather than properties; and parameter
lists spanning 17 lines with comments inside them, which broke both a fixed line window and
naive paren counting.

## Contributing

Issues and pull requests welcome.

- Run `npm test` before opening a PR; CI runs the same two suites.
- New syntax support wants a fixture in `fixtures/` plus an assertion, so the language contract
  grows with it. Fixtures are selected by *content* rather than by path, so a file
  reorganisation cannot quietly turn a test into a no-op.
- If something highlights wrongly, put the cursor on it and run **Developer: Inspect Editor
  Tokens and Scopes** — the scope name it reports is what to search for in the grammar.

## Reference

- [Platform description format](https://renode.readthedocs.io/en/latest/advanced/platform_description_format.html)
- [Monitor and script syntax](https://renode.readthedocs.io/en/latest/basic/monitor-syntax.html)
- [Using Python in Renode](https://renode.readthedocs.io/en/latest/basic/using-python.html)

## License

[MIT](LICENSE) © Farmblox Inc.

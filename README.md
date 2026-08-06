<p align="center">
  <img src="https://raw.githubusercontent.com/farmblox/vscode-renode/main/images/icon.png" width="112" alt="">
</p>

<h1 align="center">Renode for VS Code</h1>

<p align="center">
  Syntax highlighting, hovers, document links and go-to-definition for
  <a href="https://renode.io">Renode</a> platform descriptions (<code>.repl</code>)
  and Monitor scripts (<code>.resc</code>).
</p>

<p align="center">
  <a href="https://github.com/farmblox/vscode-renode/actions/workflows/test.yml"><img src="https://img.shields.io/github/actions/workflow/status/farmblox/vscode-renode/test.yml?branch=main&amp;label=test" alt="test"></a>
  <a href="https://github.com/farmblox/vscode-renode/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
</p>

## Features

### Syntax highlighting

**`.repl`** — node declarations and indented attributes; registration in all its forms
(`@ parent point`, the multi-point `@ { p1 a; p2 b }`, `<begin, +size>` ranges, `as "alias"`,
`@ none`); interrupt and GPIO wiring (`IRQ -> nvic@36`, `[0-4] -> nvic@[6-10]`,
`dst#index@irq`, `a@1 | b@2`, `-> none`); `init`, `preinit` and `reset` blocks with `add`;
`using`, `local`, `none`, `empty`, `new`, `as`; lists, dictionaries, `"…"` and `'''…'''`
strings; `//` and `/* */` comments.

**`.resc`** — Monitor commands and built-in objects; `#` comments and `:` comments, including
`:name:` and `:description:` metadata; variables, `$global.`-scoped names, `$ORIGIN` and
`$CWD`; `?=` and `=`; `@path` literals; `"…"` and `"""…"""` strings; backtick command
substitution; `macro` bodies; and Python highlighted inside `python "…"`.

### Document links

Path arguments link to their targets. Ctrl/⌘-click or <kbd>F12</kbd> opens the file.

`include`, `i`, `using "…"`, `LoadPlatformDescription`, `LoadPlatformDescriptionFromString`,
`LoadBinary`, `LoadELF`, `LoadHEX`, `LoadUImage`, `LoadFdt`, `LoadAtags`, `LoadSymbolsFrom`,
`Load`, `path add`, `resd`, `displayImage`, `logFile`, `CreateFileBackend`, `Save`, `autoSave`.

### Hovers

**Paths** show where the argument resolves and what is at that location: a script's `:name:`
and `:description:`, or the leading comment block of a `.repl`, `.cs` or `.py` file.

```
include $ORIGIN/platform/board.resc
        ╰─ platform/board.resc
           nucleo_wl55jc — brings up the SoC, seeds the OTP identity, wires the radio.
```

Paths passed to `logFile`, `CreateFileBackend`, `Save` and `autoSave` are marked as outputs,
since the file appears when the script runs.

**Node names** show the declaration, its file and line, and the comment block above it.
Declarations are found through the `using` chain, so a board overlay resolves names declared
in the SoC file it includes. A node re-opened to add wiring (`uart0:` with no type) resolves
to where its type is declared. The same works in a script for `sysbus.<peripheral>` and bare
node names, through the platform description the script loads.

**Types** point at the C# model that implements them.

**Variables** show the assignment, the expanded value, and whether `?=` marks it as an
overridable default. `$ORIGIN` and `$CWD` describe themselves and show the directory they
stand for.

**Monitor commands, built-in objects and `.repl` keywords** carry a description. A word is
described for the file it appears in: `using` is a platform-description keyword in a `.repl`
and a Monitor command in a `.resc`.

**Names a script creates** with `emulation Create…` or `mach create` report what created them
and where, including through `include`s.

### Members from C# model sources

Attribute names, wiring names and method calls resolve to the member they refer to in the
model's own C#, with its doc comment.

| In | Example | Resolves to |
|----|---------|-------------|
| `.repl` attribute | `frequency: 72000000` | a public property, or a constructor parameter |
| `.repl` wiring | `Alarm -> nvic@3` | a public `GPIO` field |
| `.resc` method on a peripheral | `sysbus.uart0 CreateFileBackend …` | the method on its class |
| `.resc` method on a created name | `medium SetPosition …` | the method, via the factory's file |
| `.resc` factory | `emulation CreateThing "x"` | the `this Emulation` extension method |

```
uart0: UART.STM32WL_UART @ sysbus <0x40008000, +0x400>
    lowPowerMode: true
    ╰─ bool lowPowerMode   // constructor parameter of STM32WL_UART
       Selects LPUART-vs-USART semantics within this part.
```

The receiver is resolved first, either to a node's declared type or to the factory that
created the name, and the member is looked up in that class. Attribute names are matched
without regard to the leading case, so `frequency:` finds `Frequency`.

Common Monitor methods (`Connect`, `LoadELF`, `RunFor`, `Tag`, the `Read*` and `Write*`
family, and others) carry their own descriptions.

### Go to definition

<kbd>F12</kbd> resolves files, nodes, types, C# members and factory methods.

## Requirements

VS Code 1.75 or newer. The extension is JavaScript and JSON with no build step and no runtime
dependencies.

## Installation

Install from a checkout. The script symlinks it into `<editor>/extensions`, so `git pull` and
a window reload pick up changes. It also finds VS Code Insiders, Cursor and Windsurf.

```sh
git clone https://github.com/farmblox/vscode-renode.git
cd vscode-renode
./install.sh          # then: Developer: Reload Window
```

`./install.sh --uninstall` removes the link. The script is idempotent, so it can run on
folder open:

```jsonc
// .vscode/tasks.json, in a repo containing Renode files
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

To build a `.vsix` instead:

```sh
npx @vscode/vsce package
code --install-extension renode-language-0.1.0.vsix
```

## Recommended setting

The platform description format takes spaces only, in multiples of four, and one indentation
level corresponds to one brace. Pin it for `.repl` files rather than letting the editor detect
it:

```json
{
  "[renode-repl]": {
    "editor.insertSpaces": true,
    "editor.tabSize": 4,
    "editor.detectIndentation": false
  }
}
```

## Cross-file resolution

Resolution follows `using` chains in platform descriptions and `include` chains in scripts.
Variables accumulate along an include chain, and a caller's value takes precedence over a `?=`
default in an included file. Each variable's `$ORIGIN` expands relative to the file that
assigned it, so a path composed in one script keeps its meaning when the value is used in
another.

A relative path resolves against the referring file's directory, then against the workspace
root, which is how Renode's own platform descriptions reference each other.

Where a script loads a platform from a variable its caller sets, the path cannot be resolved
from that file alone. Hovering it names the variable the caller supplies, and shows where it
leads when reached from a script that sets it.

## Limitations

- Member lookup reads C# from the open workspace. Renode's bundled models are not there, so
  hovering a member on one of those reports the receiver's type and declaration site instead
  of a signature.
- A member that a model does not define resolves to nothing, and a Monitor method without a
  description reports its receiver.
- Hovers are not shown inside comments.

## Development

```sh
node check-hovers.mjs                                   # resolution logic; no dependencies
npm install --no-save vscode-textmate vscode-oniguruma
node check-grammars.mjs                                 # grammars
```

`lib.js` holds the resolution logic and imports no `vscode`, which is what lets
`check-hovers.mjs` run it under plain node. `extension.js` adapts those results into VS Code
hovers, links and definitions. The grammars are TextMate JSON in `syntaxes/`, with editor
behaviour in the two `language-configuration-*.json` files.

Both suites run against the fixtures in [`fixtures/`](fixtures) — a SoC description, a board
overlay, three scripts and a C# model covering the documented syntax — and then over every
other `.repl` and `.resc` in the checkout. `check-grammars.mjs` tokenizes with the same engine
VS Code uses. `check-hovers.mjs` also checks that every path argument in the checkout resolves
to a file that exists, is marked as an output, or is supplied by a caller.

## Contributing

Issues and pull requests are welcome.

Run both checks before opening a pull request; CI runs the same ones. New syntax support
wants a fixture in `fixtures/` and an assertion alongside it. Fixtures are selected by content
rather than by path, so moving a file will not turn a test into a no-op.

For a highlighting problem, put the cursor on the token and run **Developer: Inspect Editor
Tokens and Scopes**. The scope it reports is the name to search for in the grammar.

## Reference

- [Platform description format](https://renode.readthedocs.io/en/latest/advanced/platform_description_format.html)
- [Monitor and script syntax](https://renode.readthedocs.io/en/latest/basic/monitor-syntax.html)
- [Using Python in Renode](https://renode.readthedocs.io/en/latest/basic/using-python.html)

## License

[MIT](LICENSE) © Farmblox Inc.

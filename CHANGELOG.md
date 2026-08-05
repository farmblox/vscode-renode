# Changelog

All notable changes to this extension are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-05

Initial release.

### Added

- **Syntax highlighting** for `.repl` (platform description) and `.resc` (Monitor script),
  written to the Renode language references rather than to one project's subset. Covers
  multi-point registration, `<begin, +size>` ranges, `as` aliases, `@ none`, IRQ/GPIO wiring
  in all its forms (`[0-4] -> nvic@[6-10]`, `dst#index@irq`, `a@1 | b@2`, `-> none`),
  `init`/`preinit`/`reset` blocks with `add`, `none`/`empty`/`new`/`local`, lists,
  dictionaries, `'''` strings, and — in scripts — `:` metadata comments, `$ORIGIN`/`$CWD`,
  `?=`, `@path` literals, backtick command substitution, `macro` bodies, and **embedded
  Python** inside `python "…"`.
- **Document links** on every path-valued argument, including the whole `Load*` family,
  `path add`, and the output paths `logFile` / `CreateFileBackend` / `Save` / `autoSave`.
- **Hovers** for paths (with the target's `:name:`/`:description:` or leading comment block),
  `$variables`, node declarations, Monitor commands, built-in objects, `.repl` format
  keywords, script-created names, and types.
- **Member resolution from C# model sources**: `.repl` attributes resolve to a public
  property or a constructor parameter, wiring names to public `GPIO` fields, script method
  calls to methods on the receiver's class, and `emulation Create…` to the `this Emulation`
  extension method that defines it.
- **Go-to-definition** for all of the above.
- Cross-file resolution following `using` and `include` chains, with each variable's
  `$ORIGIN` expanded relative to the file that assigned it.
- Two test suites: `check-grammars.mjs`, which tokenizes with the same TextMate engine VS
  Code uses, and `check-hovers.mjs`, which exercises the resolution logic. Both run against
  the fixtures in `fixtures/`.

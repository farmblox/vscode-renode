// Pure logic behind the hover / link / go-to-definition providers.
//
// Free of any `vscode` import: everything here is string and filesystem work, so it can be
// tested under plain node (check-hovers.mjs).
// extension.js is the thin adapter that turns these results into VS Code objects.
"use strict";

const fs = require("fs");
const path = require("path");

// ── file references ────────────────────────────────────────────────────────────
// Everything in the Monitor that takes a PATH. Kept to what Renode itself defines, not to
// what any one project happens to use: `include`/`i` load a script, a C# model or a Python
// file; the Load* family takes images, platform descriptions, device trees and symbol
// sources; the rest are backends, snapshots, logs and the search path.
// `output: true` marks a path the command WRITES. Such a path legitimately does not exist
// yet, so it must never be reported as missing — the distinction between "your path is
// wrong" and "this file appears when you run it".
const RESC_REF_PATTERNS = [
  { re: /\b(?:include|i)[ \t]+(\S+)/g, output: false },
  { re: /\b(?:LoadPlatformDescriptionFromString|LoadPlatformDescription|LoadBinary|LoadELF|LoadHEX|LoadUImage|LoadFdt|LoadAtags|LoadSymbolsFrom|Load)[ \t]+(\S+)/g, output: false },
  { re: /\b(?:displayImage|resd)[ \t]+(\S+)/g, output: false },
  { re: /\bpath[ \t]+add[ \t]+(\S+)/g, output: false },
  { re: /\b(?:logFile|CreateFileBackend|autoSave|Save)[ \t]+(\S+)/g, output: true },
];
// A .repl pulls in another with a QUOTED path.
const REPL_REF_PATTERNS = [{ re: /\busing[ \t]+"([^"]+)"/g, output: false }];

/** Every path-valued argument on one line, with the column span of the argument. */
function fileRefsInLine(lineText, languageId) {
  // A comment cannot contain a real reference. Cheap and prevents linking prose.
  const commentAt = languageId === "renode-repl"
    ? lineText.indexOf("//")
    : Math.min(...["#", ":"].map((c) => {
        const i = lineText.indexOf(c);
        return i === -1 ? Infinity : (c === ":" && i !== 0 ? Infinity : i);
      }));
  const limit = Number.isFinite(commentAt) && commentAt >= 0 ? commentAt : lineText.length;

  const out = [];
  const patterns = languageId === "renode-repl" ? REPL_REF_PATTERNS : RESC_REF_PATTERNS;
  for (const { re, output } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(lineText)) !== null) {
      const startCol = m.index + m[0].indexOf(m[1]);
      if (startCol >= limit) continue;
      out.push({ raw: m[1], startCol, endCol: startCol + m[1].length, output });
    }
  }
  return out.sort((a, b) => a.startCol - b.startCol);
}

// ── variables ──────────────────────────────────────────────────────────────────
const ASSIGN_RE = /^[ \t]*\$([A-Za-z_][A-Za-z0-9_.]*)[ \t]*\??=[ \t]*(.+?)[ \t]*$/;

/**
 * Variable assignments in a script, as name -> {value, expanded, line, defaulted}.
 * `?=` only assigns when unset, so an earlier `?=` does NOT override a later plain `=`;
 * for hover purposes the last assignment seen is the informative one.
 *
 * `expanded` has this file's own $ORIGIN/$CWD already substituted, which matters once
 * variables cross files: `$plat ?= $ORIGIN/board.repl` written in one script must keep
 * meaning THAT script's directory when the value is used inside a script it includes.
 * Expanding lazily at the point of use would silently rebase it to the wrong folder.
 */
function parseVariables(text, originDir, cwdDir) {
  const vars = new Map();
  text.split("\n").forEach((line, i) => {
    const m = ASSIGN_RE.exec(line);
    if (!m) return;
    let value = m[2].trim();
    if (/^".*"$/.test(value)) value = value.slice(1, -1);
    const expanded = value
      .replace(/\$ORIGIN/g, originDir || "$ORIGIN")
      .replace(/\$CWD/g, cwdDir || originDir || "$CWD");
    vars.set(m[1], { value, expanded, line: i, defaulted: /\?=/.test(line) });
  });
  return vars;
}

/**
 * Expand `@`, `$ORIGIN`, `$CWD` and script variables into a concrete path.
 * $ORIGIN is the INCLUDING SCRIPT's directory and $CWD the working directory. Renode makes
 * $ORIGIN available only inside scripts and $CWD only interactively.
 */
function substitutePath(raw, ctx) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("@")) s = s.slice(1); // path literal marker, not part of the path
  const vars = ctx.vars || new Map();
  for (let pass = 0; pass < 5 && s.includes("$"); pass++) {
    s = s.replace(/\$(ORIGIN|CWD|[A-Za-z_][A-Za-z0-9_.]*)/g, (whole, name) => {
      if (name === "ORIGIN") return ctx.originDir || "";
      if (name === "CWD") return ctx.cwdDir || ctx.originDir || "";
      const hit = vars.get(name);
      // `expanded` carries the $ORIGIN of the file that ASSIGNED the variable.
      return hit ? (hit.expanded !== undefined ? hit.expanded : hit.value) : whole;
    });
    if (!/\$(ORIGIN|CWD|[A-Za-z_])/.test(s)) break;
  }
  return s;
}

/**
 * Variables in a reference that nothing in scope assigns. A common script legitimately
 * reads a variable its CALLER sets (`LoadPlatformDescription $global.repl`), so this is the
 * difference between "the resolver is broken" and "this is supplied from outside".
 */
function unresolvedVariables(raw, ctx) {
  const substituted = substitutePath(raw, ctx);
  const names = new Set();
  const re = /\$([A-Za-z_][A-Za-z0-9_.]*)/g;
  let m;
  while ((m = re.exec(substituted)) !== null) names.add(m[1]);
  return [...names];
}

/**
 * Absolute path for a reference, or null when it still cannot be resolved.
 *
 * A relative path is resolved against the referring file's directory first. Renode also
 * accepts paths relative to its own root — that is how the shipped platforms are written
 * (`using "platforms/cpus/stm32f4.repl"`) — so any `ctx.fallbackDirs` are tried when the
 * file-relative guess does not exist. The file-relative guess is still what gets RETURNED
 * when nothing exists, so a "missing" hover names the path the author actually wrote.
 */
function resolveRefPath(raw, ctx) {
  const substituted = substitutePath(raw, ctx);
  if (!substituted || substituted.includes("$")) return null;
  if (path.isAbsolute(substituted)) return path.normalize(substituted);
  const primary = path.normalize(path.resolve(ctx.originDir || "", substituted));
  if (pathExists(primary)) return primary;
  for (const dir of ctx.fallbackDirs || []) {
    if (!dir) continue;
    const candidate = path.normalize(path.resolve(dir, substituted));
    if (pathExists(candidate)) return candidate;
  }
  return primary;
}

// ── descriptions ───────────────────────────────────────────────────────────────
/**
 * A script's own `:name:` / `:description:` header. These are ordinary `:` comments with a
 * convention, and a bare `:` line continues the description.
 */
function describeRescHeader(text) {
  let name = null;
  const description = [];
  for (const line of text.split("\n")) {
    const nameMatch = /^:name:[ \t]*(.*)$/.exec(line);
    if (nameMatch) { name = nameMatch[1].trim(); continue; }
    const descMatch = /^:description:[ \t]*(.*)$/.exec(line);
    if (descMatch) { description.push(descMatch[1].trim()); continue; }
    const contMatch = /^:[ \t]+(.*)$/.exec(line);
    if (contMatch && description.length) { description.push(contMatch[1].trim()); continue; }
    if (line.trim() === "" || line.startsWith(":")) continue;
    break; // past the header
  }
  return { name, description: description.join(" ").trim() || null };
}

/** The contiguous comment block at the top of a file, as prose. */
function leadingBlockComment(text, token) {
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t === "") { if (out.length) break; continue; }
    if (!t.startsWith(token)) break;
    out.push(t.slice(token.length).replace(/^[ \t]/, ""));
  }
  return out.join("\n").trim() || null;
}

/** Read a file, returning null instead of throwing. */
function readIfPossible(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return fs.readFileSync(absPath, "utf8");
  } catch { return null; }
}

/** Does anything exist at this path — file OR directory? `path add` takes a directory. */
function pathExists(absPath) {
  try { return !!absPath && fs.existsSync(absPath); } catch { return false; }
}

/** A short description of whatever a reference points at, by file type. */
function describeTarget(absPath) {
  try {
    if (pathExists(absPath) && fs.statSync(absPath).isDirectory()) {
      return { exists: true, summary: null, directory: true };
    }
  } catch { /* fall through to the file path below */ }
  const text = readIfPossible(absPath);
  if (text === null) return { exists: false, summary: null };
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".resc") {
    const { name, description } = describeRescHeader(text);
    const parts = [];
    if (name) parts.push(`**${name}**`);
    if (description) parts.push(description);
    return { exists: true, summary: parts.join("\n\n") || null };
  }
  if (ext === ".repl" || ext === ".cs") {
    return { exists: true, summary: leadingBlockComment(text, "//") };
  }
  if (ext === ".py") return { exists: true, summary: leadingBlockComment(text, "#") };
  return { exists: true, summary: null };
}

// ── .repl node index ───────────────────────────────────────────────────────────
const DECL_RE = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*(.*)$/;

/**
 * Every node a .repl declares, following its `using` chain, as name -> declaration info.
 * A bare `name:` (re-opening a node to add wiring) is not a declaration and is skipped, so
 * the entry always points at where the node's TYPE is stated.
 */
function indexRepl(absPath, seen) {
  const nodes = new Map();
  const visit = (file) => {
    const key = path.normalize(file);
    if (seen.has(key)) return;
    seen.add(key);
    const text = readIfPossible(key);
    if (text === null) return;
    const dir = path.dirname(key);
    const lines = text.split("\n");

    // Dependencies first, so a board file's own declarations win over the SoC's.
    for (const line of lines) {
      for (const ref of fileRefsInLine(line, "renode-repl")) {
        const target = path.resolve(dir, ref.raw);
        visit(target);
      }
    }

    lines.forEach((line, i) => {
      if (/^\s/.test(line) || line.trim().startsWith("//")) return;
      const m = DECL_RE.exec(line);
      if (!m || !m[2].trim()) return; // bare `name:` re-opens a node; not a declaration
      // The comment block immediately above is that node's documentation.
      const comment = [];
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (t.startsWith("//")) { comment.unshift(t.slice(2).replace(/^[ \t]/, "")); continue; }
        break;
      }
      nodes.set(m[1], {
        name: m[1],
        decl: line.trim(),
        file: key,
        line: i,
        comment: comment.join("\n").trim() || null,
      });
    });
  };
  visit(absPath);
  return nodes;
}

/**
 * The platform description a script ends up loading, following its `include` chain.
 *
 * It has to follow includes, because that is how these scripts are organised: a board
 * script sets `$global.repl` and includes a common script, and the common script is the one
 * that calls `LoadPlatformDescription $global.repl`. Looking only at the current file finds
 * the call with no value in the board script, and the value with no call in the common one.
 *
 * Variables accumulate down the chain and the CALLER's win, which is what `?=` means: an
 * included script's default must not override what the caller already set.
 */
function findPlatformRepl(absPath, ctx, seen) {
  const visited = seen || new Set();
  const key = path.normalize(absPath || "");
  if (!key || visited.has(key)) return null;
  visited.add(key);
  const text = readIfPossible(key);
  if (text === null) return null;

  const dir = path.dirname(key);
  const vars = new Map(ctx.vars || new Map());
  for (const [name, info] of parseVariables(text, dir, ctx.cwdDir)) {
    if (!vars.has(name)) vars.set(name, info); // caller's value wins
  }
  const localCtx = { originDir: dir, cwdDir: ctx.cwdDir, vars };

  const m = /\bLoadPlatformDescription[ \t]+(\S+)/.exec(text);
  if (m) {
    const resolved = resolveRefPath(m[1], localCtx);
    if (resolved && resolved.endsWith(".repl")) return resolved;
  }
  for (const line of text.split("\n")) {
    for (const ref of fileRefsInLine(line, "renode-resc")) {
      const target = resolveRefPath(ref.raw, localCtx);
      if (!target || !target.endsWith(".resc")) continue;
      const hit = findPlatformRepl(target, localCtx, visited);
      if (hit) return hit;
    }
  }
  return null;
}

// ── token at a position ────────────────────────────────────────────────────────
/**
 * The identifier under `col`, plus the dotted path it belongs to. `sysbus.lpuart1` hovered
 * on `lpuart1` yields text "lpuart1" with owner "sysbus" — which is how a peripheral in a
 * script is matched against a node in the platform description.
 */
function identifierAt(lineText, col) {
  if (col < 0 || col > lineText.length) return null;
  // `-` is part of a name: names given to emulation elements routinely contain one
  // (`uart-term`, `eth-phy`), and stopping at the hyphen split them into two words that
  // matched nothing. Node names in a platform description cannot contain `-`, so widening
  // the charset only ever rescues a lookup that would otherwise have failed.
  const isWord = (c) => /[A-Za-z0-9_-]/.test(c);
  let start = col;
  let end = col;
  while (start > 0 && isWord(lineText[start - 1])) start--;
  while (end < lineText.length && isWord(lineText[end])) end++;
  if (start === end) return null;
  const text = lineText.slice(start, end);
  if (!/^[A-Za-z_]/.test(text)) return null;
  let owner = null;
  if (start > 0 && lineText[start - 1] === ".") {
    let ownerEnd = start - 1;
    let ownerStart = ownerEnd;
    while (ownerStart > 0 && isWord(lineText[ownerStart - 1])) ownerStart--;
    owner = lineText.slice(ownerStart, ownerEnd) || null;
  }
  return { text, owner, startCol: start, endCol: end };
}

// ── comments ───────────────────────────────────────────────────────────────────
/**
 * Is this column inside a comment? A `#` comment or a `:description:` line that mentions a
 * peripheral's name would otherwise resolve to that peripheral's declaration.
 */
function isInComment(lineText, col, languageId) {
  if (languageId === "renode-repl") {
    const i = lineText.indexOf("//");
    return i !== -1 && col >= i;
  }
  if (/^[ \t]*:/.test(lineText)) return true;   // :name:, :description:, bare-`:` continuation
  const hash = lineText.indexOf("#");
  return hash !== -1 && col >= hash;
}

// ── Monitor vocabulary ─────────────────────────────────────────────────────────
// Hovering a command is the most likely thing a reader does, so the command IS the
// documentation surface. Descriptions follow the Monitor syntax reference.
const COMMANDS = {
  include: "Load and execute a script (`.resc`), or compile and register a C# model (`.cs`). Alias: `i`.",
  i: "Alias for `include`.",
  start: "Start the emulation — the selected machine, or every machine via `emulation`. Alias: `s`.",
  s: "Alias for `start`.",
  pause: "Pause the emulation. Alias: `p`.",
  p: "Alias for `pause`.",
  quit: "Close Renode. Alias: `q`.",
  q: "Alias for `quit`.",
  mach: "Machine management: `mach create \"name\"` makes one and selects it, `mach set \"name\"` switches.",
  macro: "Define a named command sequence. `macro reset \"\"\"…\"\"\"` defines the special `$reset` macro, run on machine reset.",
  runMacro: "Run a macro previously defined with `macro`, e.g. `runMacro $reset`.",
  python: "Execute a Python statement in the Monitor's interpreter, with `self.Machine` and `SystemBus` in scope.",
  echo: "Print a line. Backticks inside the string run a command and splice its result.",
  set: "Assign a variable — the command form of `$name = value`.",
  unset: "Remove a variable.",
  using: "Shorten names from a namespace, e.g. `using sysbus` to drop the `sysbus.` prefix.",
  showAnalyzer: "Open an analyzer window for a peripheral (a UART console, an LED view).",
  logFile: "Mirror Renode's log to a file. A second argument of `true` appends.",
  logLevel: "Set the log level, optionally for one peripheral: `logLevel 0 sysbus.lpuart1`.",
  log: "Write a line to Renode's own log.",
  peripherals: "List the selected machine's registered peripherals as a tree.",
  help: "List commands, or describe one: `help mach`.",
  version: "Print the Renode version.",
  currentTime: "Print the emulation's virtual time alongside real time.",
  numbersMode: "Choose how numbers are printed (hexadecimal, decimal or both).",
  verboseMode: "Show more detail about what the Monitor is doing.",
  allowPrivates: "Permit access to private fields and properties of models — for debugging a model.",
  createPlatform: "Create a machine from a platform description.",
  analyzers: "List the analyzers available for a peripheral.",
  path: "Show or extend the paths Renode searches for files.",
  require: "Fail unless a variable is set — a script asserting its own inputs.",
  tags: "List or set memory tags (named address ranges that log on access).",
  watch: "Re-run a command after every step.",
  next: "Advance execution by one step.",
  alias: "Give a command another name.",
  lastLog: "Print the most recent log entries.",
  logNetwork: "Log network traffic to a file or console.",
  displayImage: "Display an image file in a Renode window.",
  resd: "Inspect or feed a RESD file — recorded sensor data played back into a sensor model.",
  reverseExecMode: "Enable or inspect reverse execution, where supported.",
  setAndRevertAfter: "Set a value, then restore the previous one after a delay.",
  commandFromHistory: "Re-run a command from the Monitor's history by index.",
  autoSave: "Periodically snapshot the emulation to a file.",
  string: "String helpers for use inside other commands.",
};

// The .repl format's own keywords. Hovering these documents the FORMAT rather than any one
// platform — the reason they are here at all.
const REPL_KEYWORDS = {
  using: "Include another platform description. Its entries are merged, and this file's own entries override them.",
  local: "Restrict a variable to this file, so an including file does not see it.",
  init: "Monitor commands to run after the peripheral is created. `init add` appends to an inherited block instead of replacing it.",
  preinit: "Monitor commands to run BEFORE the peripheral is created. `preinit add` appends.",
  reset: "Monitor commands to run whenever the peripheral is reset. `reset add` appends.",
  add: "Append to an inherited `init` / `preinit` / `reset` block rather than replacing it.",
  none: "Cancel an inherited value or registration without supplying a new one.",
  empty: "Set the type's default — 0, null, or the first member of an enum.",
  new: "Instantiate an object inline as a property value: `new Some.Type { field: 1 }`.",
  as: "Give a registration an alias: `@ sysbus 0x1000 as \"name\"`.",
};
const OBJECTS = {
  emulation: "The emulation itself: machines, externals created with `emulation Create…`, the time source and global settings. An object rather than a command.",
  machine: "The SELECTED machine — `machine LoadPlatformDescription <repl>` gives it its hardware.",
  sysbus: "The selected machine's system bus, and the root of its peripheral tree: `sysbus.lpuart1`. Also `LoadBinary` / `LoadELF` / `ReadDoubleWord`.",
  connector: "Wires an emulation element to something else — a UART to a terminal, a radio to a medium: `connector Connect sysbus.gateway lora`.",
};

// Methods and properties on Renode's built-in objects. A member outside this table is
// described by its receiver plus the signature parsed out of the model's own source.
const MEMBERS = {
  Connect: "Wire two emulation elements together: `connector Connect <element> <target>`.",
  Disconnect: "Undo a `Connect`.",
  LoadPlatformDescription: "Give the selected machine its hardware, from a `.repl` file.",
  LoadPlatformDescriptionFromString: "Same, but from an inline platform description rather than a file.",
  LoadBinary: "Copy a raw binary into memory at an address. No entry point is set — a raw image is not an ELF.",
  LoadELF: "Load an ELF: segments go to their linked addresses and the CPU's entry point comes from the file.",
  LoadHEX: "Load an Intel HEX image, addresses taken from its records.",
  LoadUImage: "Load a U-Boot uImage.",
  LoadFdt: "Load a flattened device tree into memory.",
  LoadAtags: "Write ARM ATAGs into memory for a kernel that expects them.",
  LoadSymbolsFrom: "Read an ELF's symbol table WITHOUT writing memory — so addresses can be named.",
  RunFor: "Advance the emulation by a span of VIRTUAL time, then pause.",
  Start: "Start this element running.",
  Pause: "Pause this element.",
  Reset: "Reset it, as a hardware reset would.",
  Step: "Execute a number of instructions, then pause.",
  Tag: "Name an address range so accesses to it are logged instead of hitting nothing.",
  ClearTag: "Remove a tag set with `Tag`.",
  SilenceRange: "Stop logging accesses to a range, for a region left unmodelled.",
  CreateFileBackend: "Mirror this element's output to a file. A trailing `true` appends rather than truncates.",
  WriteByte: "Write one byte over the bus.",
  WriteWord: "Write a 16-bit word over the bus.",
  WriteDoubleWord: "Write a 32-bit word over the bus.",
  WriteQuadWord: "Write a 64-bit word over the bus.",
  ReadByte: "Read one byte over the bus.",
  ReadWord: "Read a 16-bit word over the bus.",
  ReadDoubleWord: "Read a 32-bit word over the bus.",
  ReadQuadWord: "Read a 64-bit word over the bus.",
  GetSymbolAddress: "Address of a symbol, from symbols loaded with `LoadSymbolsFrom`.",
  FindSymbolAt: "The symbol containing an address — how a bare PC becomes a function name.",
  SetRegisterUnsafe: "Write a CPU register directly, bypassing the checks a running core applies.",
  GetRegister: "Read a CPU register by number.",
  AddHook: "Run an action whenever execution reaches an address.",
  EnableProfiler: "Start writing an execution profile to a file.",
  Save: "Snapshot the emulation to a file.",
  Load: "Restore an emulation from a snapshot.",
};

/** A built-in member's description, where one is documented. */
function describeMember(name) {
  return Object.prototype.hasOwnProperty.call(MEMBERS, name) ? MEMBERS[name] : null;
}

/**
 * The CamelCase member at `col` and the token it is called on:
 *   `connector Connect ...`            -> {name: "Connect", receiver: "connector"}
 *   `sysbus.uart0 CreateFileBackend x` -> receiver "sysbus.uart0", receiverTail "uart0"
 */
function memberAt(lineText, col) {
  const re = /(?:^|[ \t])([A-Za-z_][A-Za-z0-9_.-]*)[ \t]+([A-Z][A-Za-z0-9_]*)\b/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    const start = m.index + m[0].lastIndexOf(m[2]);
    const end = start + m[2].length;
    if (col >= start && col <= end) {
      return {
        name: m[2],
        receiver: m[1],
        receiverTail: m[1].split(".").pop(),
        startCol: start,
        endCol: end,
      };
    }
    re.lastIndex = end;
  }
  return null;
}

/**
 * A public member's declaration and doc comment, PARSED from a model's own C# source.
 *
 * This is the load-bearing half of member support: every project brings its own models, so a
 * fixed table can only ever cover Renode's built-ins. Reading the declaration out of the
 * source describes a custom peripheral's methods and properties accurately, and stays
 * accurate when they change.
 */
function findModelMember(csPath, name) {
  const text = readIfPossible(csPath);
  if (text === null || !name) return null;
  const lines = text.split("\n");
  // A platform description writes `frequency:` for a C# `Frequency` (Renode matches
  // constructor parameters and properties without caring about the leading case), so try
  // both spellings rather than only what the author typed.
  const spellings = [name];
  const upper = name.charAt(0).toUpperCase() + name.slice(1);
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  if (!spellings.includes(upper)) spellings.push(upper);
  if (!spellings.includes(lower)) spellings.push(lower);
  for (const spelling of spellings) {
    const hit = findDeclaration(lines, spelling);
    if (hit) return hit;
  }
  return findConstructorParameter(lines, name);
}

/** First public declaration of `name` in these C# lines, with its doc comment. */
function findDeclaration(lines, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A public method, property or field of this name — not a use of it.
  const decl = new RegExp(`^\\s*public\\s+[^;=(){}]*\\b${escaped}\\s*(?:\\(|\\{|=>|;|$)`);
  for (let i = 0; i < lines.length; i++) {
    if (!decl.test(lines[i])) continue;
    const doc = [];
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (t.startsWith("///")) { doc.unshift(t.replace(/^\/\/\/+/, "").trim()); continue; }
      if (t.startsWith("//")) { doc.unshift(t.replace(/^\/\/+/, "").trim()); continue; }
      if (t === "" || t.startsWith("[")) continue; // blank line or attribute
      break;
    }
    return {
      signature: lines[i].trim().replace(/\s*\{\s*$/, ""),
      doc: doc.join("\n").replace(/<\/?(?:summary|remarks)>/g, "").trim() || null,
      line: i,
    };
  }
  return null;
}

/**
 * A constructor parameter of `name`, with the constructor's signature and doc comment.
 *
 * Necessary because a platform description's attributes bind to CONSTRUCTOR PARAMETERS as
 * well as to properties — `underlyingMemory:` on a flash model is a ctor argument, not a
 * property — so a property-only search reports half a model's attributes as unknown.
 */
function findConstructorParameter(lines, name) {
  for (let i = 0; i < lines.length; i++) {
    // A constructor has no return type: `public Foo(`. A method has `public T Foo(`.
    const m = /^\s*public\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lines[i]);
    if (!m) continue;
    // A parameter list can run for many lines, and real ones carry `//` comments INSIDE it
    // A clock model's constructor can span many lines with comments among the parameters.
    // Strip line comments before counting parens, and let the depth scan find the end of the
    // list rather than a fixed line budget.
    const joined = lines.slice(i, i + 120)
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    const open = joined.indexOf("(", joined.indexOf(m[1]));
    if (open === -1) continue;
    let depth = 0;
    let close = -1;
    for (let k = open; k < joined.length; k++) {
      if (joined[k] === "(") depth++;
      else if (joined[k] === ")") { depth--; if (depth === 0) { close = k; break; } }
    }
    if (close === -1) continue;
    const params = joined.slice(open + 1, close);
    // Split on commas that are not inside generics like Dictionary<a, b>.
    const parts = [];
    let buf = "";
    let angle = 0;
    for (const ch of params) {
      if (ch === "<") angle++;
      else if (ch === ">") angle--;
      if (ch === "," && angle === 0) { parts.push(buf); buf = ""; continue; }
      buf += ch;
    }
    parts.push(buf);
    for (const part of parts) {
      const trimmed = part.trim().replace(/=.*$/, "").trim();      // drop a default value
      const paramName = (trimmed.split(/[\s]+/).pop() || "").trim();
      if (!paramName) continue;
      if (paramName.toLowerCase() !== name.toLowerCase()) continue;
      const doc = [];
      for (let j = i - 1; j >= 0; j--) {
        const t = (lines[j] || "").trim();
        if (t.startsWith("///")) { doc.unshift(t.replace(/^\/\/\/+/, "").trim()); continue; }
        if (t.startsWith("//")) { doc.unshift(t.replace(/^\/\/+/, "").trim()); continue; }
        if (t === "" || t.startsWith("[")) continue;
        break;
      }
      return {
        signature: `${trimmed}   // constructor parameter of ${m[1]}`,
        doc: doc.join("\n").replace(/<\/?(?:summary|remarks)>/g, "").trim() || null,
        line: i,
      };
    }
  }
  return null;
}

const extensionIndexCache = new Map();

/**
 * Emulation/machine EXTENSION METHODS defined in a workspace's own C# — the
 * `public static void CreateThing(this Emulation ...)` pattern Renode uses to let a project
 * register its own externals. Indexed as method name -> {file, line, doc}, so
 * `emulation CreateThing "x"` describes itself from the source that defines it rather than
 * being an unknown word.
 */
function indexModelExtensions(rootDir) {
  const key = path.normalize(rootDir || "");
  if (extensionIndexCache.has(key)) return extensionIndexCache.get(key);
  const out = new Map();
  const re = /public\s+static\s+[\w<>\[\],\s]+?\s+(\w+)\s*\(\s*this\s+(?:Emulation|Machine|IMachine)\b/g;
  for (const [, file] of indexModelSources(key)) {
    const text = readIfPossible(file);
    if (text === null) continue;
    const lines = text.split("\n");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split("\n").length - 1;
      const doc = [];
      for (let j = line - 1; j >= 0; j--) {
        const t = (lines[j] || "").trim();
        if (t.startsWith("///")) { doc.unshift(t.replace(/^\/\/\/+/, "").trim()); continue; }
        if (t.startsWith("//")) { doc.unshift(t.replace(/^\/\/+/, "").trim()); continue; }
        if (t === "" || t.startsWith("[")) continue;
        break;
      }
      out.set(m[1], {
        file,
        line,
        signature: (lines[line] || "").trim(),
        doc: doc.join("\n").replace(/<\/?(?:summary|remarks)>/g, "").trim() || null,
      });
    }
  }
  extensionIndexCache.set(key, out);
  return out;
}

/**
 * The name of the node whose block `lineIndex` sits in — the nearest declaration at column 0
 * at or above it. Indented attributes and wiring belong to that node, so this is what makes
 * `frequency:` or `IRQ ->` resolvable to a C# member.
 */
function enclosingDeclaration(lines, lineIndex) {
  for (let i = Math.min(lineIndex, lines.length - 1); i >= 0; i--) {
    const line = lines[i] || "";
    if (/^\s/.test(line) || line.trim() === "" || line.trim().startsWith("//")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/.exec(line);
    if (m) return m[1];
    // Any other column-0 content ends the block.
    return null;
  }
  return null;
}

/** An indented `key:` attribute name at `col`, if the cursor is on one. */
function propertyKeyAt(lineText, col) {
  const m = /^([ \t]+)([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/.exec(lineText);
  if (!m) return null;
  const start = m[1].length;
  const end = start + m[2].length;
  return col >= start && col <= end ? { name: m[2], startCol: start, endCol: end } : null;
}

/** The signal name on the left of a `->` at `col` (`IRQ -> nvic@36`), if the cursor is on it. */
function signalNameAt(lineText, col) {
  const m = /^([ \t]*)([A-Za-z_][A-Za-z0-9_]*)[ \t]*->/.exec(lineText);
  if (!m) return null;
  const start = m[1].length;
  const end = start + m[2].length;
  return col >= start && col <= end ? { name: m[2], startCol: start, endCol: end } : null;
}

/**
 * A short description of a word from Renode's own vocabulary, if it is one.
 *
 * `languageId` selects which vocabulary applies: a platform description's `using`/`init`/
 * `reset` are FORMAT keywords, while in a script the same words are Monitor commands. A
 * .repl still gets the Monitor vocabulary as a fallback, because `init:` blocks contain
 * Monitor commands.
 */
function describeWord(word, languageId) {
  if (languageId === "renode-repl"
      && Object.prototype.hasOwnProperty.call(REPL_KEYWORDS, word)) {
    return { kind: "platform-description keyword", text: REPL_KEYWORDS[word] };
  }
  if (Object.prototype.hasOwnProperty.call(OBJECTS, word)) {
    return { kind: "object", text: OBJECTS[word] };
  }
  if (Object.prototype.hasOwnProperty.call(COMMANDS, word)) {
    return { kind: "command", text: COMMANDS[word] };
  }
  return null;
}

// ── names a script creates for itself ──────────────────────────────────────────
/**
 * Externals and machines a script names, as name -> {line, creator}.
 *
 * `emulation CreateLoraMedium "lora"` is what makes `lora` a name later lines can use, and
 * nothing in a platform description declares it — so without this, hovering `lora` in
 * `connector Connect sysbus.gateway lora` finds nothing, which is exactly the gap that made
 * the hovers look broken.
 */
function scriptExternals(text, file) {
  const out = new Map();
  text.split("\n").forEach((line, i) => {
    if (isInComment(line, 0, "renode-resc")) return;
    let m = /\bemulation[ \t]+(Create\w+)\b[^"]*"([^"]+)"/.exec(line);
    if (m) { out.set(m[2], { line: i, creator: m[1], file: file || null }); return; }
    m = /\bmach[ \t]+create[ \t]+"([^"]+)"/.exec(line);
    if (m) out.set(m[1], { line: i, creator: "mach create", file: file || null });
  });
  return out;
}

/**
 * Externals and machines reachable from a script, following its `include` chain.
 *
 * Needed because the names and their uses live in DIFFERENT files: `lora` is created by the
 * shared platform script, and a caller like run.resc then writes
 * `connector Connect sysbus.gateway lora`. Looking only at the current file leaves that name
 * unexplained, which is precisely how the hovers looked broken.
 */
function scriptExternalsChain(absPath, ctx, seen) {
  const visited = seen || new Set();
  const key = path.normalize(absPath || "");
  const out = new Map();
  if (!key || visited.has(key)) return out;
  visited.add(key);
  const text = readIfPossible(key);
  if (text === null) return out;

  const dir = path.dirname(key);
  const vars = new Map(ctx.vars || new Map());
  for (const [name, info] of parseVariables(text, dir, ctx.cwdDir)) {
    if (!vars.has(name)) vars.set(name, info);
  }
  const localCtx = { originDir: dir, cwdDir: ctx.cwdDir, vars };

  for (const [name, info] of scriptExternals(text, key)) out.set(name, info);
  for (const line of text.split("\n")) {
    for (const ref of fileRefsInLine(line, "renode-resc")) {
      const target = resolveRefPath(ref.raw, localCtx);
      if (!target || !target.endsWith(".resc")) continue;
      for (const [name, info] of scriptExternalsChain(target, localCtx, visited)) {
        if (!out.has(name)) out.set(name, info);
      }
    }
  }
  return out;
}

// ── C# model sources ───────────────────────────────────────────────────────────
const modelIndexCache = new Map();

/** Index of C# model sources under a root, as class name -> absolute path. */
function indexModelSources(rootDir) {
  const key = path.normalize(rootDir || "");
  if (modelIndexCache.has(key)) return modelIndexCache.get(key);
  const out = new Map();
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(p, depth + 1);
      } else if (e.name.endsWith(".cs")) {
        out.set(e.name.slice(0, -3), p);
      }
    }
  };
  walk(key, 0);
  modelIndexCache.set(key, out);
  return out;
}

/**
 * The dotted type path at `col`, e.g. `Sensors.Sensirion_SHTC3` — so hovering a type in a
 * platform description can point at the model that implements it.
 */
function typePathAt(lineText, col) {
  if (col < 0 || col > lineText.length) return null;
  const ok = (c) => /[A-Za-z0-9_.]/.test(c);
  let start = col;
  let end = col;
  while (start > 0 && ok(lineText[start - 1])) start--;
  while (end < lineText.length && ok(lineText[end])) end++;
  const text = lineText.slice(start, end).replace(/^\.+|\.+$/g, "");
  if (!/^[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(text)) return null;
  return { text, className: text.split(".").pop(), startCol: start, endCol: start + text.length };
}

/** The `$variable` under `col`, if any. */
function variableAt(lineText, col) {
  const re = /\$([A-Za-z_][A-Za-z0-9_.]*)/g;
  let m;
  while ((m = re.exec(lineText)) !== null) {
    if (col >= m.index && col <= m.index + m[0].length) {
      return { name: m[1], startCol: m.index, endCol: m.index + m[0].length };
    }
  }
  return null;
}

module.exports = {
  fileRefsInLine,
  parseVariables,
  substitutePath,
  resolveRefPath,
  unresolvedVariables,
  describeRescHeader,
  leadingBlockComment,
  describeTarget,
  pathExists,
  readIfPossible,
  indexRepl,
  findPlatformRepl,
  identifierAt,
  variableAt,
  isInComment,
  describeWord,
  describeMember,
  memberAt,
  findModelMember,
  findConstructorParameter,
  enclosingDeclaration,
  propertyKeyAt,
  signalNameAt,
  indexModelExtensions,
  MEMBERS,
  scriptExternals,
  scriptExternalsChain,
  indexModelSources,
  typePathAt,
  COMMANDS,
  OBJECTS,
  REPL_KEYWORDS,
};

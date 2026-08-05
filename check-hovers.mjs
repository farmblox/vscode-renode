// Test the resolution logic behind the hover, link and definition providers.
//
//   node check-hovers.mjs
//
// lib.js imports no `vscode`, so this runs under plain node with no extension host. It covers
// lib.js rather than extension.js, which is a thin adapter over these results.
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const lib = require("./lib.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = HERE;   // the extension is the repository root here

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };
const check = (cond, m, detail) => (cond ? pass(m) : fail(`${m}${detail ? " — " + detail : ""}`));

const allFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== ".git") walk(p);
    } else if (p.endsWith(".repl") || p.endsWith(".resc")) allFiles.push(p);
  }
})(REPO);
const replFiles = allFiles.filter((f) => f.endsWith(".repl"));
const rescFiles = allFiles.filter((f) => f.endsWith(".resc"));
const fileWith = (files, needle) => {
  const hit = files.find((f) => fs.readFileSync(f, "utf8").includes(needle));
  if (!hit) throw new Error(`no file containing ${JSON.stringify(needle)}`);
  return hit;
};
const FIXTURES = path.join(HERE, "fixtures");
const FIX_SOC = path.join(FIXTURES, "general_soc.repl");
const FIX_BOARD = path.join(FIXTURES, "general.repl");
const FIX_SCRIPT = path.join(FIXTURES, "general.resc");

const ctxFor = (file) => ({
  originDir: path.dirname(file),
  cwdDir: REPO,
  vars: file.endsWith(".resc")
    ? lib.parseVariables(fs.readFileSync(file, "utf8"), path.dirname(file), REPO)
    : new Map(),
});

// ── every reference in every file resolves to something that exists ─────────────
// The sharpest assertion here: a hover that says "unresolved" on a working script means the
// resolver is wrong, and this is where that would show up.
console.log("== every file reference resolves");
let refCount = 0;
const callerSupplied = [];
for (const file of allFiles) {
  const ctx = ctxFor(file);
  const languageId = file.endsWith(".repl") ? "renode-repl" : "renode-resc";
  const broken = [];
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const ref of lib.fileRefsInLine(line, languageId)) {
      refCount++;
      const target = lib.resolveRefPath(ref.raw, ctx);
      if (target) {
        // An OUTPUT path is written when the script runs, so absence is not an error.
        if (!ref.output && !lib.describeTarget(target).exists) {
          broken.push(`${i + 1}: ${ref.raw} -> ${target}`);
        }
        continue;
      }
      // Unresolvable is only acceptable when it is waiting on a variable the CALLER sets.
      const pending = lib.unresolvedVariables(ref.raw, ctx);
      if (pending.length === 0) broken.push(`${i + 1}: ${ref.raw} (unresolvable, no variable)`);
      else callerSupplied.push(`${path.relative(REPO, file)}:${i + 1} needs $${pending.join(", $")}`);
    }
  });
  check(broken.length === 0, `${path.relative(REPO, file)}`, broken.join("; "));
}
check(refCount >= 10, `found ${refCount} file references across ${allFiles.length} files`);
// The common scripts read a variable their caller sets. That is the architecture, so it
// must be REPORTED rather than treated as a resolver failure — and it must still be
// resolvable once approached from a script that sets it (asserted below).
check(callerSupplied.length > 0,
  `${callerSupplied.length} reference(s) correctly identified as caller-supplied`,
  callerSupplied.join("; "));

// ── path substitution ───────────────────────────────────────────────────────────
console.log("== path substitution");
{
  const platFile = FIX_SCRIPT;
  const ctx = ctxFor(platFile);
  const originDir = path.dirname(platFile);
  check(
    lib.resolveRefPath("$ORIGIN/peripherals", ctx) === path.join(originDir, "peripherals"),
    "$ORIGIN resolves against the script's own directory"
  );
  // The `@$ORIGIN/...` combination dev/monitor.resc uses: the `@` marker is stripped, then
  // the variable expands.
  check(
    lib.resolveRefPath("@$ORIGIN/../renode", ctx) === path.resolve(originDir, "../renode"),
    "a leading @ is stripped before substitution"
  );
  check(lib.resolveRefPath("$UNSET_THING/x", ctx) === null,
    "an unresolvable variable yields null rather than a bogus path");
  // A variable holding a path, then used as one — `machine LoadPlatformDescription $global.repl`.
  const withVar = lib.parseVariables('$global.repl ?= $ORIGIN/repl/monitor/soc/stm32wle5.repl');
  const viaVar = lib.resolveRefPath("$global.repl", { originDir, cwdDir: REPO, vars: withVar });
  check(viaVar === path.join(originDir, "repl/monitor/soc/stm32wle5.repl"),
    "a variable holding a path expands through to a file");
}

// ── variables ───────────────────────────────────────────────────────────────────
console.log("== variables");
{
  const platFile = FIX_SCRIPT;
  const vars = lib.parseVariables(fs.readFileSync(platFile, "utf8"));
  check(vars.size > 0, `parsed ${vars.size} assignment(s) from ${path.relative(REPO, platFile)}`);
  const defaulted = [...vars.values()].filter((v) => v.defaulted);
  check(defaulted.length > 0, "`?=` assignments are marked as overridable defaults");
  // The no-space form, `$lane?=0`.
  const tight = lib.parseVariables("$lane?=0");
  check(tight.get("lane") && tight.get("lane").value === "0" && tight.get("lane").defaulted,
    "`$lane?=0` parses with no spaces around the operator");
  const quoted = lib.parseVariables('$name ?= "a value"');
  check(quoted.get("name").value === "a value", "surrounding quotes are stripped from a value");
}

// ── descriptions ────────────────────────────────────────────────────────────────
console.log("== descriptions");
{
  const platFile = FIX_SCRIPT;
  const header = lib.describeRescHeader(fs.readFileSync(platFile, "utf8"));
  check(!!header.name, `:name: read from ${path.relative(REPO, platFile)}`, JSON.stringify(header.name));
  check(!!header.description && header.description.length > 40,
    "multi-line :description: joined into one paragraph",
    header.description ? `${header.description.length} chars` : "empty");
  // The bare-colon continuation form (dev/monitor.resc).
  const cont = lib.describeRescHeader([
    ":name: X",
    ":description: first part",
    ": second part",
    "",
    "$lane?=0",
  ].join("\n"));
  check(cont.description === "first part second part",
    "a bare `:` line continues the description", JSON.stringify(cont.description));
  // A .repl and a .cs are described by their leading // block.
  const socFile = FIX_SOC;
  const socSummary = lib.describeTarget(socFile);
  check(socSummary.exists && socSummary.summary && socSummary.summary.length > 40,
    "a .repl is described by its leading comment block");
  const csFile = path.join(FIXTURES, "ExampleModel.cs");
  if (fs.existsSync(csFile)) {
    const cs = lib.describeTarget(csFile);
    check(cs.exists && cs.summary && cs.summary.includes("FIXTURE"),
      "a .cs model is described by its leading comment block");
  }
  check(lib.describeTarget(path.join(REPO, "does/not/exist.repl")).exists === false,
    "a missing target reports exists=false rather than throwing");
}

// ── the .repl node index, through the `using` chain ──────────────────────────────
console.log("== node index");
{
  const boardFile = FIX_BOARD;
  const nodes = lib.indexRepl(boardFile, new Set());
  check(nodes.size >= 10, `indexed ${nodes.size} nodes from ${path.relative(REPO, boardFile)}`);
  // Declared in the board file itself.
  check(nodes.has("button"), "a node declared in the board file is indexed");
  // Declared in the SoC file the board `using`s — the whole point of following the chain.
  const soc = nodes.get("uart0");
  check(!!soc, "a node from the `using`-ed SoC file is indexed");
  if (soc) {
    check(soc.file !== boardFile, "...and points at the SoC file, not the board file",
      path.relative(REPO, soc.file));
    check(/uart0:/.test(soc.decl), "...with its declaration line", soc.decl);
    check(!!soc.comment && soc.comment.length > 20,
      "...and the comment block above it as documentation");
  }
  // A re-opened node adds wiring; the index must keep the TYPE declaration.
  const gpio = nodes.get("gpio");
  check(gpio && /GPIOPort\./.test(gpio.decl),
    "a re-opened node still points at its type declaration, not the bare re-open",
    gpio && gpio.decl);
}

// ── a .resc reaches its platform's nodes (hovering `sysbus.<peripheral>`) ────────
console.log("== script -> platform nodes");
{
  // A script that loads a platform from a variable it does NOT itself set: viewed alone,
  // there is genuinely nothing to resolve. Selected by that property rather than by name.
  const commonFile = rescFiles.find((f) => {
    const t = fs.readFileSync(f, "utf8");
    const m = /\bLoadPlatformDescription[ \t]+(\S+)/.exec(t);
    return m && lib.unresolvedVariables(m[1], ctxFor(f)).length > 0;
  });
  if (commonFile) {
    const fromCommon = lib.findPlatformRepl(commonFile, ctxFor(commonFile), new Set());
    check(fromCommon === null,
      `from ${path.relative(REPO, commonFile)} alone the platform is (correctly) unknown`,
      fromCommon ? path.relative(REPO, fromCommon) : "null");
  } else {
    pass("no caller-supplied-platform script in this corpus (nothing to assert)");
  }

  // From a BOARD script it resolves: the board sets $global.repl, then includes the common
  // script that loads it. Following the include chain is the only way to connect the two.
  // Any script from which the platform IS resolvable — whether it loads it directly or sets
  // the variable and includes a script that does.
  const boardResc = rescFiles.find(
    (f) => lib.findPlatformRepl(f, ctxFor(f), new Set()) !== null);
  check(!!boardResc, "found a script from which the platform resolves",
    boardResc ? path.relative(REPO, boardResc) : "none");
  if (boardResc) {
    const platform = lib.findPlatformRepl(boardResc, ctxFor(boardResc), new Set());
    check(!!platform && platform.endsWith(".repl"),
      `platform resolved through the include chain from ${path.relative(REPO, boardResc)}`,
      platform ? path.relative(REPO, platform) : "not found");
    if (platform) {
      check(fs.existsSync(platform), "...and the resolved platform file exists");
      const nodes = lib.indexRepl(platform, new Set());
      check(nodes.size > 5 && (nodes.has("uart0") || nodes.has("usart1") || nodes.has("lpuart1")),
        "...so a peripheral named in the script resolves to a node in the platform",
        `${nodes.size} nodes`);
    }
  }
}

// ── token at a position ─────────────────────────────────────────────────────────
console.log("== token at a position");
{
  const line = "connector Connect sysbus.usart1 harness-uart";
  const col = line.indexOf("usart1") + 2;
  const ident = lib.identifierAt(line, col);
  check(ident && ident.text === "usart1" && ident.owner === "sysbus",
    "a dotted peripheral yields the member plus its owner",
    ident ? `${ident.owner}.${ident.text}` : "null");
  const irqLine = "    IRQ -> nvic@36";
  const nvic = lib.identifierAt(irqLine, irqLine.indexOf("nvic") + 1);
  check(nvic && nvic.text === "nvic" && nvic.owner === null,
    "a connection destination yields the bare node name");
  check(lib.identifierAt("    0x40013800", 6) === null,
    "a hex number is not offered as an identifier");
  const varLine = "$global.repl ?= $ORIGIN/x";
  const v = lib.variableAt(varLine, 3);
  check(v && v.name === "global.repl", "a $variable is recognised at the cursor",
    v ? v.name : "null");
  check(lib.variableAt(varLine, varLine.indexOf("$ORIGIN") + 2).name === "ORIGIN",
    "$ORIGIN is recognised as a variable");
}

// ── references are not harvested from comments ──────────────────────────────────
console.log("== comments are not references");
{
  check(lib.fileRefsInLine("// see using \"other.repl\" for why", "renode-repl").length === 0,
    "a .repl comment mentioning `using` yields no reference");
  check(lib.fileRefsInLine("# include $ORIGIN/x.resc is done above", "renode-resc").length === 0,
    "a .resc `#` comment yields no reference");
  check(lib.fileRefsInLine(":description:   include @foo.bin", "renode-resc").length === 0,
    "a :description: line yields no reference");
  check(lib.fileRefsInLine("include $ORIGIN/real.resc", "renode-resc").length === 1,
    "...while a real include still does");
}


// ── THE LANGUAGE CONTRACT: general Renode fixtures ──────────────────────────────
// Assertions against the fixtures, which cover the platform-description and Monitor
// references directly.
console.log("== language contract (fixtures/)");
{
  const FIX = path.join(HERE, "fixtures");
  const soc = path.join(FIX, "general_soc.repl");
  const board = path.join(FIX, "general.repl");
  const script = path.join(FIX, "general.resc");
  for (const f of [soc, board, script, path.join(FIX, "image.bin")]) {
    check(fs.existsSync(f), `fixture present: ${path.basename(f)}`);
  }

  // --- platform description ---
  const nodes = lib.indexRepl(board, new Set());
  check(nodes.has("led") && nodes.has("gpio"), "board-file nodes indexed");
  for (const n of ["flash", "sram", "nvic", "cpu", "uart0", "exti", "timer", "mock"]) {
    check(nodes.has(n), `SoC node reachable through \`using\`: ${n}`);
  }
  check(/GPIOPort\./.test(nodes.get("gpio").decl), "`as \"alias\"` does not break the declaration");
  check(nodes.get("spare") && /@ none/.test(nodes.get("spare").decl),
    "a node registered `@ none` is still indexed");
  // A re-opened node must keep pointing at where its TYPE is declared, in the other file.
  check(nodes.get("uart0").file === soc,
    "re-opening `uart0:` in the board file keeps the SoC declaration",
    path.relative(REPO, nodes.get("uart0").file));
  check(!!nodes.get("exti").comment, "the comment above a declaration is captured");

  // --- platform-description KEYWORDS are documented as such ---
  for (const kw of ["using", "local", "init", "preinit", "reset", "add", "none", "empty", "new", "as"]) {
    const d = lib.describeWord(kw, "renode-repl");
    check(!!d && d.kind === "platform-description keyword", `.repl keyword documented: ${kw}`);
  }
  // The same word in a SCRIPT is a Monitor command, not a format keyword.
  const usingInScript = lib.describeWord("using", "renode-resc");
  check(!!usingInScript && usingInScript.kind === "command",
    "`using` in a script is documented as the Monitor command instead");

  // --- Monitor vocabulary ---
  for (const c of ["include", "i", "mach", "macro", "runMacro", "python", "echo", "set",
                   "showAnalyzer", "logFile", "logLevel", "numbersMode", "path", "start",
                   "pause", "quit", "help", "peripherals", "resd", "displayImage"]) {
    check(!!lib.describeWord(c, "renode-resc"), `Monitor command documented: ${c}`);
  }
  for (const o of ["emulation", "machine", "sysbus", "connector"]) {
    const d = lib.describeWord(o, "renode-resc");
    check(!!d && d.kind === "object", `built-in object documented as an object: ${o}`);
  }

  // --- script: variables, externals, platform, path kinds ---
  const sctx = ctxFor(script);
  const svars = lib.parseVariables(fs.readFileSync(script, "utf8"), FIX, REPO);
  check(svars.has("image") && svars.has("port") && svars.has("global.plat"),
    "script variables parsed, including a $global-scoped one");
  const externals = lib.scriptExternalsChain(script, sctx, new Set());
  for (const [name, creator] of [["board", "mach create"], ["term", "CreateServerSocketTerminal"],
                                 ["medium", "CreateLoraMedium"]]) {
    check(externals.get(name) && externals.get(name).creator === creator,
      `name created by the script is found: ${name} (${creator})`);
  }
  const platform = lib.findPlatformRepl(script, sctx, new Set());
  check(platform === board, "the script's platform description resolves",
    platform ? path.relative(REPO, platform) : "null");
  const viaScript = lib.indexRepl(platform, new Set());
  check(viaScript.has("uart0") && viaScript.has("cpu"),
    "so `sysbus.uart0` in the script reaches the SoC node");

  // Input vs OUTPUT paths — a written path must never be reported as missing.
  const lines = fs.readFileSync(script, "utf8").split("\n");
  const refFor = (needle) => {
    for (const line of lines) {
      if (!line.includes(needle)) continue;
      const r = lib.fileRefsInLine(line, "renode-resc")[0];
      if (r) return r;
    }
    return null;
  };
  const logRef = refFor("logFile");
  check(logRef && logRef.output === true, "`logFile` target is marked as an output");
  const backendRef = refFor("CreateFileBackend");
  check(backendRef && backendRef.output === true, "`CreateFileBackend` target is marked as an output");
  const binRef = refFor("LoadBinary $image");
  check(binRef && binRef.output === false, "`LoadBinary` target is an input");
  check(lib.resolveRefPath("$ORIGIN/image.bin", sctx) === path.join(FIX, "image.bin"),
    "an input path resolves to the fixture image");
  // `path add` takes a DIRECTORY, which must count as existing.
  const dirRef = refFor("path add");
  check(dirRef && lib.describeTarget(lib.resolveRefPath(dirRef.raw, sctx)).exists,
    "`path add` resolves to a directory and counts as existing");

  // Renode also resolves relative to its own root, not only to the referring file.
  const rootFallback = lib.resolveRefPath("fixtures/general_soc.repl", {
    originDir: path.join(FIX, "nowhere"), cwdDir: HERE, vars: new Map(), fallbackDirs: [HERE],
  });
  check(rootFallback === soc, "a root-relative path resolves via the fallback root",
    rootFallback ? path.relative(REPO, rootFallback) : "null");


  // --- CUSTOM members, parsed from the model's own C# ---------------------------
  // The load-bearing half: a fixed table can only ever cover Renode's built-ins, so every
  // other member is described from source. Verified here against a fixture model rather
  // than any project's, so the guarantee is about the language.
  const example = lib.indexModelSources(FIX).get("ExampleModel");
  check(!!example, "a C# model in the fixture set is indexed");
  for (const [member, want] of [
    ["frequency", "public ulong Frequency"],        // property, lowercase in the .repl
    ["Frequency", "public ulong Frequency"],        // and as written in C#
    ["Alarm", "public GPIO Alarm"],                 // GPIO output used by `->` wiring
    ["Poke", "public void Poke(int times)"],        // method called from a script
  ]) {
    const hit = lib.findModelMember(example, member);
    check(hit && hit.signature.startsWith(want), `member parsed from C#: ${member}`,
      hit ? hit.signature : "not found");
    check(hit && !!hit.doc, `...with its doc comment: ${member}`);
  }
  // A .repl attribute binds to a CONSTRUCTOR PARAMETER as readily as to a property, and the
  // parameter list here carries comments inside it.
  const ctorParam = lib.findModelMember(example, "label");
  check(ctorParam && /constructor parameter/.test(ctorParam.signature),
    "a .repl attribute resolves to a constructor parameter",
    ctorParam ? ctorParam.signature : "not found");
  check(lib.findModelMember(example, "noSuchMember") === null,
    "an unknown member resolves to nothing rather than a wrong guess");

  // Custom `emulation Create…` factories are discovered by parsing `this Emulation`
  // extension methods, so a project's own externals are documented too.
  const factories = lib.indexModelExtensions(FIX);
  const madeBy = factories.get("CreateExampleThing");
  check(!!madeBy && /CreateExampleThing/.test(madeBy.signature),
    "a custom `emulation Create…` factory is found by parsing the C#",
    madeBy ? madeBy.signature : "not found");
  check(!!madeBy && !!madeBy.doc, "...with its doc comment");

  // Built-in members still come from the table.
  for (const m of ["Connect", "LoadBinary", "LoadELF", "RunFor", "Tag", "WriteDoubleWord",
                   "ReadDoubleWord", "LoadSymbolsFrom", "Step", "CreateFileBackend"]) {
    check(!!lib.describeMember(m), `built-in member documented: ${m}`);
  }
  check(lib.describeMember("SomeUnknownThing") === null,
    "an undocumented built-in member is not invented");

  // Position handling: which token is the member, and what is it called on.
  const mem1 = lib.memberAt("connector Connect sysbus.gateway lora", 12);
  check(mem1 && mem1.name === "Connect" && mem1.receiver === "connector",
    "member and receiver identified in `connector Connect ...`");
  const mem2 = lib.memberAt("sysbus.uart0 CreateFileBackend @out.log true", 20);
  check(mem2 && mem2.name === "CreateFileBackend" && mem2.receiverTail === "uart0",
    "a dotted receiver yields the peripheral as the receiver tail",
    mem2 ? mem2.receiverTail : "null");
  check(lib.memberAt("connector Connect sysbus.gateway lora", 3) === null,
    "the receiver itself is not reported as the member");

  // .repl attribute / signal positions, and the node they belong to.
  const replLines = fs.readFileSync(path.join(FIX, "general_soc.repl"), "utf8").split("\n");
  const freqLine = replLines.findIndex((l) => /^\s+frequency:/.test(l));
  check(lib.enclosingDeclaration(replLines, freqLine) !== null,
    "an indented attribute is attributed to its enclosing declaration",
    String(lib.enclosingDeclaration(replLines, freqLine)));
  const alarmLine = replLines.findIndex((l) => /^\s+Alarm ->/.test(l));
  check(lib.enclosingDeclaration(replLines, alarmLine) === "example",
    "a wiring line is attributed to its enclosing declaration");
  check(!!lib.propertyKeyAt(replLines[freqLine], 6), "attribute key recognised at the cursor");
  check(!!lib.signalNameAt(replLines[alarmLine], 5), "signal name recognised at the cursor");
  check(lib.propertyKeyAt("example: Fixtures.ExampleModel @ sysbus 0x60000000", 3) === null,
    "a declaration line is not mistaken for an attribute");

  // --- types resolve to the model that implements them ---
  const models = lib.indexModelSources(REPO);
  check(models.size >= 1, `indexed ${models.size} C# model source(s)`);
  const t = lib.typePathAt("uart0: UART.STM32_UART @ sysbus 0x40011000", 10);
  check(t && t.text === "UART.STM32_UART" && t.className === "STM32_UART",
    "a dotted type is recognised with its class name", t ? t.text : "null");
  const known = lib.typePathAt("x: Fixtures.ExampleModel @ sysbus", 6);
  check(known && models.has(known.className),
    "a type implemented in this workspace resolves to its .cs source");
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures ? 1 : 0);

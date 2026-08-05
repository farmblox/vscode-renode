// Tokenize every .repl / .resc file in the checkout with the same TextMate engine VS Code
// uses, and assert the scope assigned to representative constructs.
//
//   npm install --no-save vscode-textmate vscode-oniguruma
//   node check-grammars.mjs
//
// Fixtures come first: they cover the documented syntax. The sweep over the remaining files
// checks that nothing in the checkout fails to tokenize.
//
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const oniguruma = require("vscode-oniguruma");
const vsctm = require("vscode-textmate");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = HERE;   // the extension is the repository root here
const SYN = path.join(HERE, "syntaxes");

await oniguruma.loadWASM(
  fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"))
);

const registry = new vsctm.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (s) => new oniguruma.OnigScanner(s),
    createOnigString: (s) => new oniguruma.OnigString(s),
  }),
  loadGrammar: async (scopeName) => {
    if (scopeName === "source.python") {
      // VS Code ships the Python grammar. Here it MUST be stubbed rather than left null:
      // an unresolvable include invalidates the whole rule containing it, which silently
      // disabled both rules that embed Python (`pythonInline`, and `multilineString`
      // through it) and let a single `"` win over `"""`.
      return vsctm.parseRawGrammar(
        JSON.stringify({
          scopeName: "source.python",
          patterns: [
            { match: "\\b(?:import|self|def|return|None|True|False)\\b", name: "keyword.control.python" },
            { match: "=", name: "keyword.operator.assignment.python" },
            { match: "\\b[0-9]+\\b", name: "constant.numeric.python" },
            { begin: "'", end: "'", name: "string.quoted.single.python" },
          ],
        }),
        "python-stub.json"
      );
    }
    const file =
      scopeName === "source.renode-repl" ? "renode-repl.tmLanguage.json"
      : scopeName === "source.renode-resc" ? "renode-resc.tmLanguage.json"
      : null;
    if (!file) return null;
    return vsctm.parseRawGrammar(fs.readFileSync(path.join(SYN, file), "utf8"), file);
  },
});

async function tokenize(scope, text) {
  const grammar = await registry.loadGrammar(scope);
  if (!grammar) throw new Error(`grammar ${scope} failed to load`);
  const out = [];
  let ruleStack = vsctm.INITIAL;
  for (const line of text.split("\n")) {
    const r = grammar.tokenizeLine(line, ruleStack);
    ruleStack = r.ruleStack;
    out.push(r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes })));
  }
  return out;
}

let failures = 0;
const pass = (m) => console.log(`  ok   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); failures++; };

// Assert the token whose text is exactly `text` carries a scope containing `scopeFragment`.
// `onLineWith` narrows to lines containing a substring — needed because a name like
// `status_led` appears both as a declaration and as a connection destination, and those
// legitimately carry different scopes.
function expectScope(lines, text, scopeFragment, label, onLineWith) {
  let sawText = false;
  for (const toks of lines) {
    if (onLineWith && !toks.map((t) => t.text).join("").includes(onLineWith)) continue;
    for (const t of toks) {
      if (t.text.trim() === text) {
        sawText = true;
        if (t.scopes.some((s) => s.includes(scopeFragment))) {
          return pass(`${label}: "${text}" -> ${scopeFragment}`);
        }
        return fail(`${label}: "${text}" got [${t.scopes.join(", ")}], wanted *${scopeFragment}*`);
      }
    }
  }
  fail(`${label}: token "${text}" ${sawText ? "found but unmatched" : "never produced as its own token"}`);
}

// Select fixtures by CONTENT, never by path: these files get reorganised, and a hardcoded
// path would turn this test into a silent no-op the day one moved.
function fileContaining(files, needle) {
  const hit = files.find((f) => fs.readFileSync(f, "utf8").includes(needle));
  if (!hit) throw new Error(`no file containing ${JSON.stringify(needle)}`);
  return hit;
}

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

// ---- .repl -------------------------------------------------------------------
const FIX = path.join(HERE, "fixtures");
const boardFile = path.join(FIX, "general.repl");
console.log(`== .repl: ${path.relative(REPO, boardFile)}`);
const repl = await tokenize("source.renode-repl", fs.readFileSync(boardFile, "utf8"));
expectScope(repl, "gpio", "entity.name.type", "declaration name");
expectScope(repl, "GPIOPort.STM32_GPIOPort", "support.class", "type path");
expectScope(repl, "as", "keyword.other", "registration alias keyword");
expectScope(repl, "@", "keyword.operator.registration", "registration op");
expectScope(repl, "+0x400", "constant.numeric", "range size");
expectScope(repl, "->", "keyword.operator.connection", "connection op");
expectScope(repl, "led", "variable.other.object", "connection dest", "->");
expectScope(repl, "using", "keyword.control.import", "using keyword");
expectScope(repl, "invert", "variable.other.property", "indented attribute");
expectScope(repl, "true", "constant.language.boolean", "boolean value");
expectScope(repl, "porta", "string.quoted.double", "registration alias string");
expectScope(repl, "local", "keyword.other", "`local` scope keyword");

const socFile = path.join(FIX, "general_soc.repl");
console.log(`== .repl: ${path.relative(REPO, socFile)}`);
const soc = await tokenize("source.renode-repl", fs.readFileSync(socFile, "utf8"));
expectScope(soc, "SomeEnum.FirstMember", "support.constant", "dotted enum value");
expectScope(soc, "new", "keyword.other", "inline object keyword");
expectScope(soc, "alpha", "string.quoted.double", "list element string");
expectScope(soc, "IRQ", "variable.other.member", "named IRQ source");
expectScope(soc, "cortex-m4", "string.quoted.double", "string value");
expectScope(soc, "[0-4]", "variable.other.member", "irq range source");
expectScope(soc, "[6-10]", "constant.numeric", "irq range dest");

console.log("== .repl: synthesised forms");
// A pin number as the connection source.
expectScope(
  await tokenize("source.renode-repl", "    1 -> status_led@0"),
  "1", "constant.numeric", "pin-number connection source"
);
// Further forms from the platform-description reference.
const extras = await tokenize("source.renode-repl", [
  'phy: Network.Phy @ ethernet 0 as "eth-phy"',
  "    irq -> gic#1@42 | cpu@3",
  "    mode: none",
  "    fallback: empty",
  "    sub: new Some.Type { a: 1 }",
  "    init:",
  '        Tag <0x1000, +0x100> "REG"',
  "/* block comment */",
].join("\n"));
expectScope(extras, "as", "keyword.other", "`as` alias keyword");
expectScope(extras, "none", "constant.language", "`none` cancels a value");
expectScope(extras, "empty", "constant.language", "`empty` type default");
expectScope(extras, "new", "keyword.other", "`new` inline object");
expectScope(extras, "init", "keyword.control", "init block");
expectScope(extras, "block comment", "comment.block", "block comment");
expectScope(extras, "#", "punctuation.separator", "local-index separator");

// ---- .resc -------------------------------------------------------------------
const platFile = path.join(FIX, "general.resc");
console.log(`== .resc: ${path.relative(REPO, platFile)}`);
const resc = await tokenize("source.renode-resc", fs.readFileSync(platFile, "utf8"));
expectScope(resc, ":name:", "keyword.other.directive", "metadata directive");
expectScope(resc, "?=", "keyword.operator.assignment", "assign-if-unset");
expectScope(resc, "$ORIGIN", "variable.language", "$ORIGIN special");
expectScope(resc, "global", "storage.modifier", "$global scope");
expectScope(resc, "include", "keyword.other.command", "include command");
expectScope(resc, "emulation", "support.class", "emulation object");
expectScope(resc, "CreateLoraMedium", "entity.name.function", "method on an object");
expectScope(resc, "sysbus", "support.class", "sysbus object");
expectScope(resc, "WriteDoubleWord", "entity.name.function", "sysbus method");
expectScope(resc, "mach", "keyword.other.command", "mach command");
expectScope(resc, "macro", "keyword.other.command", "macro command");
expectScope(resc, "medium", "variable.other.object", "user object target", "SetPosition");
expectScope(resc, "SetPosition", "entity.name.function", "user object method");

const devFile = path.join(FIX, "general.resc");
console.log(`== .resc: ${path.relative(REPO, devFile)}`);
const dev = await tokenize("source.renode-resc", fs.readFileSync(devFile, "utf8"));
expectScope(dev, "python", "keyword.other.command", "python command");
expectScope(dev, "showAnalyzer", "keyword.other.command", "showAnalyzer command");
expectScope(dev, "echo", "keyword.other.command", "echo command");
{
  const flat = dev.flat();
  flat.some((t) => t.scopes.some((s) => s.includes("meta.embedded.block.python")))
    ? pass("embedded python region produced")
    : fail("no meta.embedded.block.python region");
  flat.some((t) => t.scopes.some((s) => s.includes("command-substitution")))
    ? pass("backtick command substitution produced")
    : fail("no backtick substitution region");
}

console.log("== .resc: the reset-macro form");
// A triple-quoted body wrapping a double-quoted python statement. Must be ONE
// triple-quoted region: a single `"` winning here would end the string on the first quote
// and mis-colour everything after it.
const tri = await tokenize("source.renode-resc", 'macro reset """ python "cpu=1" """');
expectScope(tri, "macro", "keyword.other.command", "macro before a triple-quoted body");
{
  const flat = tri.flat();
  flat.some((t) => t.scopes.some((s) => s.includes("string.quoted.triple")))
    ? pass("triple-quoted body is one string region")
    : fail("no string.quoted.triple region");
  flat.some((t) => t.scopes.some((s) => s.includes("meta.embedded.block.python")))
    ? pass("python embedded inside the triple-quoted body")
    : fail("python not embedded inside the macro body");
  const stray = flat.filter(
    (t) => t.text === '"' && !t.scopes.some((s) => s.includes("triple") || s.includes("python"))
  ).length;
  stray === 0
    ? pass("no stray single-quote string tokens in the body")
    : fail(stray + " stray quote token(s) — the single-quote rule beat the triple-quote rule");
}

// ---- every file tokenizes, and little is left unscoped ------------------------
console.log("== all files");
for (const f of allFiles) {
  const scope = f.endsWith(".repl") ? "source.renode-repl" : "source.renode-resc";
  try {
    const toks = (await tokenize(scope, fs.readFileSync(f, "utf8"))).flat();
    const nonBlank = toks.filter((t) => t.text.trim().length);
    const scoped = nonBlank.filter((t) => t.scopes.length > 1).length;
    const pct = nonBlank.length ? Math.round((scoped / nonBlank.length) * 100) : 100;
    console.log(`  ok   ${path.relative(REPO, f)}  (${pct}% of non-blank tokens scoped)`);
  } catch (e) {
    fail(`${path.relative(REPO, f)} threw: ${e.message}`);
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${allFiles.length} files`);
process.exit(failures ? 1 : 0);

// VS Code glue for the Renode grammars: hovers, ctrl-click links and go-to-definition.
//
// Built to Renode's language references, not to any one project: what it understands is the
// .repl format and the Monitor's script syntax, verified against the general fixtures in
// fixtures/. All the real work is in lib.js, which imports no `vscode` and is therefore
// testable by plain node (check-hovers.mjs). This file only turns those results into VS Code
// objects, so a bug here is a wiring bug and a bug there is caught by the test.
//
// What it provides, for both .repl and .resc:
//   * every path-valued argument becomes a link (ctrl-click / F12 opens it)
//   * hovering a path shows where it resolves to and what the target IS — a script's
//     :name:/:description:, or a .repl/.cs file's leading comment block
//   * hovering a node name in a .repl shows its declaration and its documentation, found
//     through the `using` chain; F12 jumps there
//   * in a .resc, the same works for `sysbus.<peripheral>`, resolved through the platform
//     description the script loads (following its include chain)
//   * hovering a $variable shows its assignment and what it expands to
//   * hovering a Monitor command, a built-in object, or a .repl format keyword documents it
//   * hovering a type points at the C# model implementing it
"use strict";

const path = require("path");
const vscode = require("vscode");
const lib = require("./lib");

const LANGS = ["renode-repl", "renode-resc"];

/** Resolution context for a document: its own directory, the workspace root, its variables. */
function contextFor(document) {
  const docDir = path.dirname(document.uri.fsPath);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const root = folder ? folder.uri.fsPath : docDir;
  return {
    originDir: docDir,
    cwdDir: root,
    // Renode accepts paths relative to its own root as well as to the referring file —
    // that is how the shipped platforms are written. The workspace stands in for it.
    fallbackDirs: [root],
    vars: document.languageId === "renode-resc"
      ? lib.parseVariables(document.getText(), docDir, folder ? folder.uri.fsPath : docDir)
      : new Map(),
  };
}

/**
 * Every file reference in a document. `target` is null when a variable the CALLER supplies
 * leaves it unresolvable — kept rather than dropped so the hover can say so, while links
 * and definitions skip it.
 */
function fileRefs(document) {
  const ctx = contextFor(document);
  const out = [];
  for (let line = 0; line < document.lineCount; line++) {
    const text = document.lineAt(line).text;
    for (const ref of lib.fileRefsInLine(text, document.languageId)) {
      out.push({
        target: lib.resolveRefPath(ref.raw, ctx),
        pending: lib.unresolvedVariables(ref.raw, ctx),
        output: ref.output,
        raw: ref.raw,
        range: new vscode.Range(line, ref.startCol, line, ref.endCol),
      });
    }
  }
  return out;
}

/** The node index reachable from a document (its own `using` chain, or its platform's). */
function nodesFor(document) {
  if (document.languageId === "renode-repl") {
    return lib.indexRepl(document.uri.fsPath, new Set());
  }
  const platform = lib.findPlatformRepl(document.uri.fsPath, contextFor(document), new Set());
  return platform ? lib.indexRepl(platform, new Set()) : new Map();
}

function relToWorkspace(document, absPath) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  return folder ? path.relative(folder.uri.fsPath, absPath) : absPath;
}

/**
 * Where a member call's receiver is implemented, and the member's declaration in it.
 *
 * Three ways a receiver can lead to source, in order of specificity:
 *   1. a node in the platform description -> its type -> the C# class of that name
 *   2. a name the script created with `emulation Create…` -> the file defining that factory
 *   3. a built-in object (`sysbus`, `emulation`, …) -> no project source; the table applies
 */
function resolveMember(document, member) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const root = folder ? folder.uri.fsPath : path.dirname(document.uri.fsPath);
  const models = lib.indexModelSources(root);

  // 1. A declared node: take its type and find the class.
  const node = nodesFor(document).get(member.receiverTail);
  if (node) {
    const type = lib.typePathAt(node.decl, node.decl.indexOf(":") + 2);
    const file = type ? models.get(type.className) : null;
    const note = type
      ? `\`${member.receiver}\` is \`${type.text}\`, declared in `
        + `\`${relToWorkspace(document, node.file)}:${node.line + 1}\`.`
      : null;
    if (file) {
      return { file, source: lib.findModelMember(file, member.name), receiverNote: note };
    }
    return { file: null, source: null, receiverNote: note };
  }

  // 2. A name the script created — the factory's own file holds the implementation.
  if (document.languageId === "renode-resc") {
    const made = lib.scriptExternalsChain(
      document.uri.fsPath, contextFor(document), new Set()).get(member.receiverTail);
    if (made) {
      const factory = lib.indexModelExtensions(root).get(made.creator);
      const note = `\`${member.receiver}\` was created by \`${made.creator}\`.`;
      if (factory) {
        return {
          file: factory.file,
          source: lib.findModelMember(factory.file, member.name),
          receiverNote: note,
        };
      }
      return { file: null, source: null, receiverNote: note };
    }
    // 3. `emulation CreateThing "x"` itself, where CreateThing is defined in this workspace.
    const factory = lib.indexModelExtensions(root).get(member.name);
    if (factory) {
      return {
        file: factory.file,
        source: { signature: factory.signature, doc: factory.doc, line: factory.line },
        receiverNote: null,
      };
    }
  }
  return { file: null, source: null, receiverNote: null };
}

const hoverProvider = {
  provideHover(document, position) {
    const lineText = document.lineAt(position.line).text;

    // 0. Never hover inside a comment. A `#` comment or a `:description:` line mentioning
    //    "gateway" would otherwise pop that peripheral's declaration.
    if (lib.isInComment(lineText, position.character, document.languageId)) return undefined;

    // 1. A path-valued argument: where it resolves, and what is there.
    for (const ref of fileRefs(document)) {
      if (!ref.range.contains(position)) continue;
      const md = new vscode.MarkdownString();
      md.supportThemeIcons = true;
      if (!ref.target) {
        // Supplied from outside: a common script reads a variable its caller sets.
        const names = ref.pending.map((n) => `\`$${n}\``).join(", ");
        md.appendMarkdown(`${names} is set by the script that includes this one.\n\n`);
        const platform = lib.findPlatformRepl(document.uri.fsPath, contextFor(document), new Set());
        if (platform) {
          md.appendMarkdown(`Resolves to \`${relToWorkspace(document, platform)}\` `
            + "when reached from a script that sets it.");
        }
        return new vscode.Hover(md, ref.range);
      }
      const shown = relToWorkspace(document, ref.target);
      const info = lib.describeTarget(ref.target);
      if (!info.exists && ref.output) {
        md.appendMarkdown(`\`${shown}\`\n\n`);
        md.appendMarkdown("Output path — written when this runs, so it need not exist yet.");
        return new vscode.Hover(md, ref.range);
      }
      if (!info.exists) {
        md.appendMarkdown(`$(error) **missing** \`${shown}\`\n\n`);
        md.appendMarkdown("Nothing at that path. A `$ORIGIN`-relative path resolves against"
          + " the directory of the file it is written in, not the working directory.");
        return new vscode.Hover(md, ref.range);
      }
      md.appendMarkdown(`\`${shown}\`\n\n`);
      if (info.summary) md.appendMarkdown(`${info.summary}\n`);
      return new vscode.Hover(md, ref.range);
    }

    // 2. A $variable: its assignment and what it expands to.
    if (document.languageId === "renode-resc") {
      const hit = lib.variableAt(lineText, position.character);
      if (hit) {
        const ctx = contextFor(document);
        const md = new vscode.MarkdownString();
        if (hit.name === "ORIGIN" || hit.name === "CWD") {
          const dir = hit.name === "ORIGIN" ? ctx.originDir : ctx.cwdDir;
          md.appendMarkdown(`**$${hit.name}** — \`${dir}\`\n\n`);
          md.appendMarkdown(hit.name === "ORIGIN"
            ? "The directory of the script being executed. Scripts only — it is not available interactively."
            : "The working directory. Interactive Monitor only — it is not available in a script.");
        } else {
          const assigned = ctx.vars.get(hit.name);
          if (!assigned) return undefined;
          md.appendMarkdown(`**$${hit.name}** = \`${assigned.value}\`\n\n`);
          const expanded = lib.substitutePath(assigned.value, ctx);
          if (expanded && expanded !== assigned.value) md.appendMarkdown(`→ \`${expanded}\`\n\n`);
          md.appendMarkdown(assigned.defaulted
            ? `Default from \`?=\` on line ${assigned.line + 1} — assigned only if not already set, so a caller can override it.`
            : `Assigned on line ${assigned.line + 1}.`);
        }
        return new vscode.Hover(md, new vscode.Range(
          position.line, hit.startCol, position.line, hit.endCol));
      }
    }

    // 2b. In a platform description, an attribute key or a signal name is a MEMBER of the
    //     enclosing node's model class. Resolving it through the C# source is what makes a
    //     CUSTOM peripheral's properties and GPIO outputs documented rather than opaque.
    if (document.languageId === "renode-repl") {
      const lines = document.getText().split("\n");
      const owner = lib.enclosingDeclaration(lines, position.line);
      const key = lib.propertyKeyAt(lineText, position.character)
        || lib.signalNameAt(lineText, position.character);
      if (owner && key) {
        const resolved = resolveMember(document, { name: key.name, receiver: owner, receiverTail: owner });
        const range = new vscode.Range(position.line, key.startCol, position.line, key.endCol);
        const md = new vscode.MarkdownString();
        if (resolved.source) {
          md.appendCodeblock(resolved.source.signature, "csharp");
          md.appendMarkdown(
            `\n\`${relToWorkspace(document, resolved.file)}:${resolved.source.line + 1}\`\n`);
          if (resolved.source.doc) md.appendMarkdown(`\n${resolved.source.doc}\n`);
          return new vscode.Hover(md, range);
        }
        if (resolved.receiverNote) {
          md.appendMarkdown(`**${key.name}** — on \`${owner}\`\n\n${resolved.receiverNote}`);
          return new vscode.Hover(md, range);
        }
      }
    }

    // 3. A node name: its declaration and documentation.
    const ident = lib.identifierAt(lineText, position.character);
    const identRange = ident
      ? new vscode.Range(position.line, ident.startCol, position.line, ident.endCol)
      : null;
    if (ident) {
      const node = nodesFor(document).get(ident.text);
      if (node) {
        const md = new vscode.MarkdownString();
        md.appendCodeblock(node.decl, "renode-repl");
        md.appendMarkdown(`\n\`${relToWorkspace(document, node.file)}:${node.line + 1}\`\n`);
        if (node.comment) md.appendMarkdown(`\n${node.comment}\n`);
        return new vscode.Hover(md, identRange);
      }
    }

    // 4. A name the SCRIPT creates: an external or a machine. Nothing in a platform
    //    description declares these, so they are only findable here.
    if (ident && document.languageId === "renode-resc") {
      const made = lib.scriptExternalsChain(
        document.uri.fsPath, contextFor(document), new Set()).get(ident.text);
      if (made) {
        const md = new vscode.MarkdownString();
        const where = made.file && made.file !== document.uri.fsPath
          ? ` in \`${relToWorkspace(document, made.file)}\``
          : "";
        md.appendMarkdown(
          `**${ident.text}** — created by \`${made.creator}\` on line ${made.line + 1}${where}.`);
        return new vscode.Hover(md, identRange);
      }
    }

    // 5. A Monitor command or built-in object — the most likely thing to hover.
    if (ident) {
      const described = lib.describeWord(ident.text, document.languageId);
      if (described) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${ident.text}** *(${described.kind})*\n\n${described.text}`);
        return new vscode.Hover(md, identRange);
      }
    }

    // 5b. A method or property call. Built-ins are documented from a table; ANY other member
    //     is described from the model's own C# source, which is what makes custom
    //     peripherals and custom `emulation Create…` factories work.
    const member = lib.memberAt(lineText, position.character);
    if (member) {
      const range = new vscode.Range(
        position.line, member.startCol, position.line, member.endCol);
      const resolved = resolveMember(document, member);
      const md = new vscode.MarkdownString();
      if (resolved.source) {
        md.appendCodeblock(resolved.source.signature, "csharp");
        md.appendMarkdown(
          `\n\`${relToWorkspace(document, resolved.file)}:${resolved.source.line + 1}\`\n`);
        if (resolved.source.doc) md.appendMarkdown(`\n${resolved.source.doc}\n`);
        return new vscode.Hover(md, range);
      }
      const builtin = lib.describeMember(member.name);
      if (builtin) {
        md.appendMarkdown(`**${member.name}**\n\n${builtin}`);
        return new vscode.Hover(md, range);
      }
      // Nothing authoritative to say about the member itself — so say what it is called ON,
      // which is true and often the thing you actually wanted.
      md.appendMarkdown(`**${member.name}** — a method or property on \`${member.receiver}\``);
      if (resolved.receiverNote) md.appendMarkdown(`\n\n${resolved.receiverNote}`);
      return new vscode.Hover(md, range);
    }

    // 6. A type in a platform description: point at the model that implements it.
    const type = lib.typePathAt(lineText, position.character);
    if (type) {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      const root = folder ? folder.uri.fsPath : path.dirname(document.uri.fsPath);
      const source = lib.indexModelSources(root).get(type.className);
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`\`${type.text}\`\n\n`);
      if (source) {
        md.appendMarkdown(`Model: \`${relToWorkspace(document, source)}\`\n`);
        const info = lib.describeTarget(source);
        if (info.summary) md.appendMarkdown(`\n${info.summary}\n`);
      } else {
        md.appendMarkdown("No model source in this repo — one of Renode's bundled models.");
      }
      return new vscode.Hover(md, new vscode.Range(
        position.line, type.startCol, position.line, type.endCol));
    }

    return undefined;
  },
};

const linkProvider = {
  provideDocumentLinks(document) {
    return fileRefs(document)
      .filter((ref) => ref.target && lib.describeTarget(ref.target).exists)
      .map((ref) => {
        const link = new vscode.DocumentLink(ref.range, vscode.Uri.file(ref.target));
        link.tooltip = relToWorkspace(document, ref.target);
        return link;
      });
  },
};

const definitionProvider = {
  provideDefinition(document, position) {
    const lineText = document.lineAt(position.line).text;
    if (lib.isInComment(lineText, position.character, document.languageId)) return undefined;
    for (const ref of fileRefs(document)) {
      if (ref.range.contains(position) && ref.target && lib.describeTarget(ref.target).exists) {
        return new vscode.Location(vscode.Uri.file(ref.target), new vscode.Position(0, 0));
      }
    }
    if (document.languageId === "renode-repl") {
      const owner = lib.enclosingDeclaration(document.getText().split("\n"), position.line);
      const key = lib.propertyKeyAt(lineText, position.character)
        || lib.signalNameAt(lineText, position.character);
      if (owner && key) {
        const r = resolveMember(document, { name: key.name, receiver: owner, receiverTail: owner });
        if (r.file && r.source) {
          return new vscode.Location(vscode.Uri.file(r.file), new vscode.Position(r.source.line, 0));
        }
      }
    }
    const member = lib.memberAt(lineText, position.character);
    if (member) {
      const resolved = resolveMember(document, member);
      if (resolved.file && resolved.source) {
        return new vscode.Location(
          vscode.Uri.file(resolved.file), new vscode.Position(resolved.source.line, 0));
      }
    }
    const ident = lib.identifierAt(lineText, position.character);
    const node = ident ? nodesFor(document).get(ident.text) : null;
    if (!node) {
      // A type resolves to the C# model that implements it.
      const type = lib.typePathAt(lineText, position.character);
      if (type) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const root = folder ? folder.uri.fsPath : path.dirname(document.uri.fsPath);
        const source = lib.indexModelSources(root).get(type.className);
        if (source) {
          return new vscode.Location(vscode.Uri.file(source), new vscode.Position(0, 0));
        }
      }
      return undefined;
    }
    return new vscode.Location(
      vscode.Uri.file(node.file), new vscode.Position(node.line, 0));
  },
};

function activate(context) {
  for (const language of LANGS) {
    context.subscriptions.push(
      vscode.languages.registerHoverProvider(language, hoverProvider),
      vscode.languages.registerDocumentLinkProvider(language, linkProvider),
      vscode.languages.registerDefinitionProvider(language, definitionProvider)
    );
  }
}

function deactivate() {}

module.exports = { activate, deactivate };

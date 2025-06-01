import * as path from "path";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { activateFormatter } from "./formatter";
import { findProjectRoot } from "./filepath";

import * as vscode from "vscode";

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
  // LSP サーバーのパスを指定
  const serverModule = context.asAbsolutePath(
    path.join("dist", "server", "main.js"),
  );

  const PROJECT_ROOT = findProjectRoot();

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        env: {
          PROJECT_ROOT: PROJECT_ROOT,
        },
      },
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        env: {
          PROJECT_ROOT: PROJECT_ROOT,
        },
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "lunas" }],
  };

  // LSP クライアントを起動
  client = new LanguageClient(
    "lunasLanguageServer",
    "Lunas Language Server",
    serverOptions,
    clientOptions,
  );
  client.start();

  // フォーマット機能を有効化
  activateFormatter(context);

  // --------------------------------------------------
  // Toggle comment for .lun blocks based on html/style/script sections
  context.subscriptions.push(
    vscode.commands.registerCommand("lunas.toggleComment", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        console.log("No active editor found.");
        return;
      }
      const doc = editor.document;
      const selection = editor.selection;
      const startLine = selection.start.line;
      const endLine = selection.end.line;

      // Determine block type by scanning upward from the start line
      let block: "html" | "css" | "js" | null = null;
      for (let l = startLine; l >= 0; l--) {
        const text = doc.lineAt(l).text.trim();
        if (text === "html:") {
          block = "html";
          break;
        }
        if (text === "style:") {
          block = "css";
          break;
        }
        if (text === "script:") {
          block = "js";
          break;
        }
      }
      console.log(`Detected block: ${block}`);

      // Fallback to default comment toggle if no block is detected
      if (!block) {
        console.log("No block detected, using default comment command.");
        return vscode.commands.executeCommand("editor.action.commentLine");
      }

      // Edit all lines in the selection
      await editor.edit((editBuilder) => {
        for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
          const line = doc.lineAt(lineNum);
          const lineText = line.text;
          const range = new vscode.Range(lineNum, 0, lineNum, lineText.length);
          const indentMatch = lineText.match(/^\s*/);
          const indent = indentMatch ? indentMatch[0] : "";
          const content = lineText.trim();
          let newText: string;

          if (block === "html") {
            if (content.startsWith("<!--")) {
              newText = indent + content.replace(/^<!--\s?/, "").replace(/\s?-->$/, "");
              console.log("Uncommenting HTML line:", lineText);
            } else {
              newText = `${indent}<!-- ${content} -->`;
              console.log("Commenting HTML line:", lineText);
            }
          } else if (block === "css") {
            if (content.startsWith("/*")) {
              newText = indent + content.replace(/^\/\*\s?/, "").replace(/\s?\*\/$/, "");
              console.log("Uncommenting CSS line:", lineText);
            } else {
              newText = `${indent}/* ${content} */`;
              console.log("Commenting CSS line:", lineText);
            }
          } else {
            if (content.startsWith("//")) {
              newText = indent + content.replace(/^\/\/\s?/, "");
              console.log("Uncommenting JS line:", lineText);
            } else {
              newText = `${indent}// ${content}`;
              console.log("Commenting JS line:", lineText);
            }
          }

          editBuilder.replace(range, newText);
        }
      });
      console.log("Toggle comment finished for selected lines.");
    }),
  );
  // --------------------------------------------------

  console.log("Congratulations, your extension 'lunas' is now active!");
}

export function deactivate(): Thenable<void> | undefined {
  return client ? client.stop() : undefined;
}

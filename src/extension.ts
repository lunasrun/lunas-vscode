import * as vscode from "vscode";
import * as path from "path";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { activateFormatter } from "./formatter";
import { findProjectRoot } from "./filepath";

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

  console.log("Congratulations, your extension 'lunas' is now active!");
}

export function deactivate(): Thenable<void> | undefined {
  return client ? client.stop() : undefined;
}

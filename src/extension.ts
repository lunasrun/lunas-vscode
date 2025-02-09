import * as vscode from "vscode";
import * as path from "path";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import { activateFormatter } from "./formatter";

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
  // LSP サーバーのパスを指定
  const serverModule = context.asAbsolutePath(path.join("dist", "server.js"));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
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

  console.log("Congratulations, your extension 'lunas' is now active!");

  // フォーマット機能を有効化
  activateFormatter(context);
}

export function deactivate(): Thenable<void> | undefined {
  return client ? client.stop() : undefined;
}

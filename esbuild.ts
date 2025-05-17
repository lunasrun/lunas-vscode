import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// ビルド対象のエントリーポイント
const entryPoints = ["src/extension.ts", "src/server/main.ts"];

async function main() {
  const ctx = await esbuild.context({
    entryPoints,
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outdir: "dist", // 複数ファイル出力のため outdir を使用
    external: ["vscode", "prettier"],
    logLevel: "warning",
    plugins: [esbuildProblemMatcherPlugin],
    pure: ["console.log", "console.debug", "console.info", "console.warn", "console.error"],
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

const esbuildProblemMatcherPlugin: esbuild.Plugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });

    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location == null) return;
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log("[watch] build finished");
    });
  },
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

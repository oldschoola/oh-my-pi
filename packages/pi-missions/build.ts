import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compile } from "@tailwindcss/node";

async function extractTailwindClasses(dir: string): Promise<Set<string>> {
	const classes = new Set<string>();
	const classPattern = /className\s*=\s*["'`]([^"'`]+)["'`]/g;

	async function scanDir(currentDir: string): Promise<void> {
		const entries = await fs.readdir(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				await scanDir(fullPath);
			} else if (entry.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry.name)) {
				const content = await Bun.file(fullPath).text();
				const matches = content.matchAll(classPattern);
				for (const match of matches) {
					for (const cls of match[1].split(/\s+/)) {
						if (cls) classes.add(cls);
					}
				}
			}
		}
	}

	await scanDir(dir);
	return classes;
}

await fs.rm("./dist/client", { recursive: true, force: true });

console.log("Building Tailwind CSS...");
const sourceCss = await Bun.file("./src/client/styles.css").text();
const candidates = await extractTailwindClasses("./src/client");
const baseDir = path.resolve("./src/client");

const compiler = await compile(sourceCss, {
	base: baseDir,
	onDependency: () => {},
});
const tailwindOutput = compiler.build([...candidates]);

const xtermCssPath = await resolveXtermCss();
const xtermCss = await Bun.file(xtermCssPath).text();
await Bun.write("./dist/client/styles.css", `${tailwindOutput}\n${xtermCss}`);

console.log("Building React app...");
const result = await Bun.build({
	entrypoints: ["./src/client/index.tsx"],
	outdir: "./dist/client",
	target: "browser",
	minify: true,
	naming: "[dir]/[name].[ext]",
});

if (!result.success) {
	console.error("Build failed");
	for (const message of result.logs) {
		console.error(message);
	}
	process.exit(1);
}

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MissionControl</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

await Bun.write("./dist/client/index.html", indexHtml);

console.log("Build complete");

async function resolveXtermCss(): Promise<string> {
	// Prefer Bun.resolveSync — follows the resolution Bun will use at runtime.
	try {
		return Bun.resolveSync("@xterm/xterm/css/xterm.css", import.meta.dir);
	} catch {}
	// Workspace fallback: scan for a hoisted copy.
	const glob = new Bun.Glob("**/node_modules/@xterm/xterm/css/xterm.css");
	for await (const p of glob.scan({ cwd: path.resolve("../.."), absolute: true })) {
		return p;
	}
	throw new Error("Could not locate @xterm/xterm/css/xterm.css — did `bun install` run?");
}

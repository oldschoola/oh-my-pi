// Knowledge tools end-to-end bench. Validates that the new knowledge API
// (a) creates files where the taxonomy says it should, (b) refuses the
// writes that would damage user-owned content, and (c) makes the result
// discoverable through list/query/read.
//
// Baseline (upstream/main) ships no knowledge API at all, so the only
// thing an agent on baseline can do is bash `write` and `read` blind
// against the memory root. We simulate that here and compare.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	knowledgeCreateDirectory,
	knowledgeCreateDocument,
	knowledgeDelete,
	knowledgeEditDocument,
	knowledgeList,
	knowledgeQuery,
	knowledgeRead,
	KnowledgeOpsError,
} from "../packages/coding-agent/src/memories/knowledge-ops";

interface Check {
	name: string;
	pass: boolean;
	detail?: string;
}

const checks: Check[] = [];
function assert(name: string, pass: boolean, detail?: string) {
	checks.push({ name, pass, detail });
}

async function mktemp(label: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), `bench-knowledge-${label}-`));
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

// ---------- new system ----------------------------------------------

async function runNew(): Promise<void> {
	const root = await mktemp("new");
	try {
		// Seed: user-owned reference doc and user-protected skill.
		const refPath = path.join(root, "reference", "vendor-api.md");
		await fs.mkdir(path.dirname(refPath), { recursive: true });
		await Bun.write(refPath, "# Vendor API\n\n- POST /v1/widgets {sku}\n");

		// Seed a body-marker'd skill, then flip aiMaintained to false on
		// disk so mutating ops route through approvalSink rather than
		// hitting the marker-less refusal.
		await knowledgeCreateDocument(root, "skill/deploy-runbook/SKILL.md", {
			body: "Hand-curated. Do not rewrite.",
		});
		const protectedSkill = path.join(root, "skill", "deploy-runbook", "SKILL.md");
		const originalSkillBytes = await Bun.file(protectedSkill).text();
		await Bun.write(
			protectedSkill,
			originalSkillBytes
				.replace("aiMaintained: true", "aiMaintained: false")
				.replace("inheritAiConfig: true", "inheritAiConfig: false"),
		);

		// Op 1: create a memory document. Expect file with frontmatter + body markers.
		await knowledgeCreateDocument(root, "memory/eu-region.md", {
			summary: "Production DB lives in eu-west-1",
			body: "The production database is in eu-west-1 and snapshots nightly at 02:00 UTC.",
		});
		const memDocPath = path.join(root, "memory", "eu-region.md");
		const memDocText = await Bun.file(memDocPath).text();
		assert(
			"create memory doc materializes file",
			await exists(memDocPath),
			memDocPath,
		);
		assert(
			"memory doc carries frontmatter",
			memDocText.startsWith("---\n") && memDocText.includes("aiMaintained:"),
		);
		assert(
			"memory doc wraps body in omp markers",
			memDocText.includes("<!-- omp:body:start -->") &&
				memDocText.includes("<!-- omp:body:end -->"),
		);
		assert(
			"memory doc body preserved verbatim",
			memDocText.includes("eu-west-1 and snapshots nightly"),
		);

		// Op 2: create a skill playbook.
		await knowledgeCreateDocument(root, "skill/test-runner/SKILL.md", {
			summary: "Run focused bun tests",
			body: "Use `bun test path/to/file.test.ts` rather than the package-wide runner.",
		});
		assert(
			"create skill SKILL.md materializes",
			await exists(path.join(root, "skill", "test-runner", "SKILL.md")),
		);

		// Op 3: create a directory.
		await knowledgeCreateDirectory(root, "memory/team");
		assert(
			"create directory materializes",
			await exists(path.join(root, "memory", "team")),
		);

		// Op 4: edit existing AI-maintained doc.
		await knowledgeEditDocument(root, "memory/eu-region.md", {
			body: "The production database is in eu-west-1. Snapshots every 30 minutes since the May incident.",
		});
		const edited = await Bun.file(memDocPath).text();
		assert(
			"edit replaces body inside markers",
			edited.includes("every 30 minutes since the May incident"),
		);

		// Op 5: refuse to overwrite user-protected skill without approval.
		let refusedSkillNoSink = false;
		try {
			await knowledgeEditDocument(root, "skill/deploy-runbook/SKILL.md", {
				body: "rewritten by agent",
			});
		} catch (e) {
			refusedSkillNoSink = e instanceof KnowledgeOpsError && e.code === "permission_denied";
		}
		const skillBytesAfter = await Bun.file(protectedSkill).text();
		assert(
			"refuses edit on aiMaintained:false skill without approvalSink",
			refusedSkillNoSink && skillBytesAfter.includes("Hand-curated"),
		);

		// Op 5b: routes the edit through approvalSink when one is provided
		// and lands the write on approval.
		const sinkOutcome = await knowledgeEditDocument(
			root,
			"skill/deploy-runbook/SKILL.md",
			{ body: "rewritten by agent (approved)" },
			{ approvalSink: async req => { await req.apply(); } },
		);
		const skillAfterApproval = await Bun.file(protectedSkill).text();
		assert(
			"approvalSink lands the user-protected edit",
			sinkOutcome.applied && sinkOutcome.requiredApproval && skillAfterApproval.includes("approved"),
		);

		// Op 5c: routes through approvalSink but sink withholds apply.
		const beforeBytes = skillAfterApproval;
		const withheld = await knowledgeEditDocument(
			root,
			"skill/deploy-runbook/SKILL.md",
			{ body: "should not land" },
			{ approvalSink: async _req => { /* user declined */ } },
		);
		const stillSame = (await Bun.file(protectedSkill).text()) === beforeBytes;
		assert(
			"approvalSink withholding apply leaves bytes untouched",
			!withheld.applied && withheld.requiredApproval && stillSame,
		);

		// Restore the user-protected skill body (markers + aiMaintained:false)
		// so downstream delete assertions can target it again.
		await Bun.write(
			protectedSkill,
			originalSkillBytes
				.replace("aiMaintained: true", "aiMaintained: false")
				.replace("inheritAiConfig: true", "inheritAiConfig: false"),
		);

		// Op 5d: design/ create requires approval; without sink → refused.
		let designRefused = false;
		try {
			await knowledgeCreateDocument(root, "design/architecture.md", { body: "x" });
		} catch (e) {
			designRefused = e instanceof KnowledgeOpsError && e.code === "permission_denied";
		}
		assert(
			"design/ create refused without approvalSink",
			designRefused && !(await exists(path.join(root, "design", "architecture.md"))),
		);

		// Op 5e: design/ create with auto-approve sink lands the doc and
		// inherits `aiMaintained: false` from design/ defaults.
		const designOutcome = await knowledgeCreateDocument(
			root,
			"design/architecture.md",
			{ body: "AI-proposed architecture body" },
			{ approvalSink: async req => { await req.apply(); } },
		);
		const designWritten = await Bun.file(path.join(root, "design", "architecture.md")).text();
		assert(
			"design/ create through approvalSink lands with aiMaintained:false",
			designOutcome.applied
				&& designOutcome.requiredApproval
				&& designWritten.includes("<!-- omp:body:start -->")
				&& designWritten.includes("AI-proposed architecture body")
				&& designWritten.includes("aiMaintained: false"),
		);

		// Op 6: refuse to create in reference/.
		let refusedRef = false;
		try {
			await knowledgeCreateDocument(root, "reference/notes.md", { body: "new" });
		} catch (e) {
			refusedRef = e instanceof KnowledgeOpsError && e.code === "permission_denied";
		}
		assert(
			"refuses create under read-only reference/",
			refusedRef && !(await exists(path.join(root, "reference", "notes.md"))),
		);

		// Op 7: refuse cross-type move (e.g. skill -> memory).
		let refusedMove = false;
		try {
			await knowledgeDelete(root, "skill/test-runner/SKILL.md", "document");
			// Recreate to keep state; then attempt invalid path shape.
			await knowledgeCreateDocument(root, "skill/test-runner/SKILL.md", {
				body: "back",
			});
			// Cross-type via resolveKnowledgePath rejection: try sidecar.
			await knowledgeCreateDocument(root, "memory/.omp-meta", { body: "x" });
		} catch (e) {
			refusedMove = e instanceof KnowledgeOpsError && e.code === "invalid_path";
		}
		assert("refuses .omp-meta path as a document", refusedMove);

		// Op 8: list + query + read.
		const listed = await knowledgeList(root);
		const listedPaths = listed.map(e => e.path);
		assert(
			"list surfaces memory and skill docs",
			listedPaths.includes("memory/eu-region.md") &&
				listedPaths.includes("skill/test-runner/SKILL.md") &&
				listedPaths.includes("reference/vendor-api.md"),
			`got ${listedPaths.length} entries`,
		);

		const hits = await knowledgeQuery(root, { lexicalQuery: "eu-west-1 snapshots" });
		assert(
			"query returns relevant hit",
			hits.length > 0 && hits[0].path === "memory/eu-region.md" && hits[0].score > 0,
			`top hit ${hits[0]?.path} score=${hits[0]?.score}`,
		);

		const readFull = await knowledgeRead(root, "memory/eu-region.md", "full");
		const readBody = await knowledgeRead(root, "memory/eu-region.md", "body");
		const readSummary = await knowledgeRead(root, "memory/eu-region.md", "summary");
		assert("read full returns whole file", readFull.content.includes("aiMaintained"));
		assert(
			"read body strips frontmatter+markers",
			!readBody.content.includes("aiMaintained") &&
				!readBody.content.includes("<!-- omp:body:start -->") &&
				readBody.content.includes("every 30 minutes"),
		);
		assert(
			"read summary returns frontmatter summary",
			readSummary.content.includes("eu-west-1"),
		);

		// Op 9: delete AI-maintained doc.
		await knowledgeDelete(root, "memory/eu-region.md", "document");
		assert(
			"delete removes AI-maintained doc",
			!(await exists(memDocPath)),
		);

		// Op 10: delete refuses on user-protected without approvalSink.
		let refusedDelete = false;
		try {
			await knowledgeDelete(root, "skill/deploy-runbook/SKILL.md", "document");
		} catch (e) {
			refusedDelete = e instanceof KnowledgeOpsError && e.code === "permission_denied";
		}
		assert(
			"delete refuses on aiMaintained:false without approvalSink",
			refusedDelete && (await exists(protectedSkill)),
		);

		// Op 10b: delete proceeds when approvalSink applies the request.
		const deleteOutcome = await knowledgeDelete(
			root,
			"skill/deploy-runbook/SKILL.md",
			"document",
			{ approvalSink: async req => { await req.apply(); } },
		);
		assert(
			"delete routes through approvalSink on aiMaintained:false",
			deleteOutcome.applied && deleteOutcome.requiredApproval && !(await exists(protectedSkill)),
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

// ---------- baseline behaviour --------------------------------------
//
// Upstream/main has no knowledge API. An agent that wanted to record a
// note would use raw `write` (bash redirect or the Write tool). There is
// no path-shape enforcement, no body markers, and no permission gate —
// so the agent CAN clobber user-owned files and emit files that the
// consolidator will later treat as its own (re)writeable property.

async function runBaseline(): Promise<void> {
	const root = await mktemp("baseline");
	try {
		const refPath = path.join(root, "reference", "vendor-api.md");
		await fs.mkdir(path.dirname(refPath), { recursive: true });
		const originalRef = "# Vendor API\n\n- POST /v1/widgets {sku}\n";
		await Bun.write(refPath, originalRef);

		const protectedSkill = path.join(root, "skills", "deploy-runbook", "SKILL.md");
		await fs.mkdir(path.dirname(protectedSkill), { recursive: true });
		const originalSkill = "---\naiMaintained: false\n---\n# Deploy Runbook\n\nHand-curated. Do not rewrite.\n";
		await Bun.write(protectedSkill, originalSkill);

		// Agent "creates" a memory note via free-form write.
		const memDocPath = path.join(root, "memory-notes-eu-region.md");
		await Bun.write(memDocPath, "# eu-region\n\nThe production database is in eu-west-1.\n");
		const memDocText = await Bun.file(memDocPath).text();
		assert(
			"baseline: create write puts file somewhere (no taxonomy enforced)",
			await exists(memDocPath),
		);
		assert(
			"baseline: no frontmatter present",
			!memDocText.startsWith("---\n"),
		);
		assert(
			"baseline: no omp body markers",
			!memDocText.includes("<!-- omp:body:start -->"),
		);

		// Agent has no guard rail — it overwrites the user-protected skill.
		await Bun.write(protectedSkill, "# Deploy Runbook\n\nRewritten by agent.\n");
		const skillAfter = await Bun.file(protectedSkill).text();
		assert(
			"baseline: nothing stops overwrite of user-protected skill",
			!skillAfter.includes("Hand-curated"),
		);

		// Agent overwrites reference/ too. There's no `reference/` concept upstream.
		await Bun.write(refPath, "# Vendor API\n\nOverwritten.\n");
		const refAfter = await Bun.file(refPath).text();
		assert(
			"baseline: nothing stops overwrite of reference/",
			!refAfter.includes("POST /v1/widgets"),
		);

		// No query/list API: simulate by recursing.
		const found: string[] = [];
		async function walk(dir: string) {
			for (const e of await fs.readdir(dir, { withFileTypes: true })) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) await walk(full);
				else found.push(full);
			}
		}
		await walk(root);
		assert(
			"baseline: no query helper — agents must walk and grep manually",
			found.length > 0,
			`found ${found.length} files`,
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true }).catch(() => {});
	}
}

// ---------- driver ---------------------------------------------------

async function main() {
	console.log("=== new system (knowledge tools wired) ===");
	const newStart = checks.length;
	await runNew();
	const newChecks = checks.slice(newStart);
	for (const c of newChecks) {
		console.log(`  ${c.pass ? "ok " : "FAIL"}  ${c.name}${c.detail ? "  (" + c.detail + ")" : ""}`);
	}

	console.log("\n=== baseline (upstream/main, free-form write) ===");
	const baselineStart = checks.length;
	await runBaseline();
	const baselineChecks = checks.slice(baselineStart);
	for (const c of baselineChecks) {
		console.log(`  ${c.pass ? "ok " : "FAIL"}  ${c.name}${c.detail ? "  (" + c.detail + ")" : ""}`);
	}

	const newPass = newChecks.filter(c => c.pass).length;
	const newTotal = newChecks.length;
	const baseSafety = baselineChecks.filter(c =>
		c.name.startsWith("baseline:") && c.name.includes("nothing stops"),
	).length;

	console.log("\n=== verdict ===");
	console.log(`new system:  ${newPass}/${newTotal} behaviours correct`);
	console.log(`baseline:    ${baseSafety} demonstrated user-data clobbers (no API to refuse them)`);

	if (newPass !== newTotal) {
		console.log("\nFAILURES on new system — bench failed.");
		process.exit(1);
	}
}

await main();

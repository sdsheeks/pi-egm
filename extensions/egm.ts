/**
 * pi-egm — pi adapter for the Elephant-Goldfish Model (EGM).
 *
 * EGM is a set of skills plus reviewer personas ("Goldfish") that must run in a
 * fresh context, with no access to the conversation that produced the document.
 * pi has no subagent tool, so this extension adds one:
 *
 *   - `subagent` runs a separate `pi --mode json -p --no-session` process per
 *     reviewer. The child process starts empty, so the review is genuinely
 *     fresh-context: parent turns are never passed to it.
 *   - Personas are read from the vendored upstream bundle in `egm/agents/*.md`.
 *     Their frontmatter `name` (egm-zoom-out, egm-design, ...) is the agent name
 *     that EGM skills request.
 *   - Reviewers get read-only tools only (read, grep, find, ls), matching the
 *     "Strict Read-Only Protocol" in every EGM persona.
 *   - EGM skill text refers to paths relative to the plugin root
 *     (`agents/<x>.md`, `resources/document_standards/<x>.md`, `../../docs/`).
 *     The system prompt section added by this extension states that root, and
 *     each reviewer prompt carries the same note.
 *
 * Delegation mechanics (spawn arguments, JSON event handling, abort handling)
 * follow the `subagent` example shipped with @earendil-works/pi-coding-agent.
 *
 * Upstream EGM is Apache-2.0 and is vendored unmodified under egm/.
 * See NOTICE and egm/UPSTREAM.json.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EGM_ROOT = path.join(PKG_ROOT, "egm");
const PERSONA_DIR = path.join(EGM_ROOT, "agents");

/** Tools a Goldfish reviewer may use. EGM reviewers are strictly read-only. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

/**
 * Reviewer model override. Reviewers inherit the session model by default; set
 * PI_EGM_REVIEWER_MODEL to run every reviewer on a different model.
 */
const REVIEWER_MODEL = process.env.PI_EGM_REVIEWER_MODEL?.trim() || undefined;

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_OUTPUT_BYTES = 50_000;

interface Persona {
	name: string;
	description: string;
	systemPrompt: string;
	filePath: string;
	/** Optional `model:` from persona frontmatter; overrides the session model. */
	model?: string;
}

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface RunResult {
	agent: string;
	task: string;
	exitCode: number;
	text: string;
	stderr: string;
	usage: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

/**
 * Path note appended to every reviewer prompt. EGM skill text is shared across
 * harnesses and addresses paths from the plugin root, so state the root
 * explicitly instead of forking that text.
 */
function adapterNote(): string {
	return [
		"",
		"---",
		"",
		"## Harness notes (pi adapter)",
		"",
		`- EGM plugin root: ${EGM_ROOT}`,
		"- Paths in this persona such as `agents/<file>.md`, `resources/document_standards/<file>.md`,",
		"  and `../../docs/<file>.md` are relative to the EGM plugin root, not to the project.",
		"- The project under review is your working directory.",
		"- You are strictly read-only. Report findings; never modify files, run builds, or run tests.",
		"- Ignore harness instructions for Antigravity (`invoke_subagent`), Claude Code (`Agent` tool,",
		"  `${CLAUDE_PLUGIN_ROOT}`), Codex/ChatGPT (`spawn_agent`), omp, and Muse.",
	].join("\n");
}

function loadPersonas(): Persona[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(PERSONA_DIR, { withFileTypes: true });
	} catch {
		return [];
	}

	const personas: Persona[] = [];
	const seen = new Set<string>();

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md")) continue;
		const filePath = path.join(PERSONA_DIR, entry.name);

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let parsed: { frontmatter: Record<string, unknown>; body: string };
		try {
			parsed = parseFrontmatter<Record<string, unknown>>(content);
		} catch {
			continue;
		}

		const name = parsed.frontmatter.name;
		const description = parsed.frontmatter.description;
		if (typeof name !== "string" || typeof description !== "string") continue;
		if (seen.has(name)) continue;
		seen.add(name);

		personas.push({
			name,
			description,
			systemPrompt: `${parsed.body.trimEnd()}\n${adapterNote()}\n`,
			filePath,
			model:
				typeof parsed.frontmatter.model === "string" && parsed.frontmatter.model.trim()
					? parsed.frontmatter.model.trim()
					: undefined,
		});
	}

	return personas;
}

const PERSONAS = loadPersonas();

function personaList(): string {
	if (PERSONAS.length === 0) return "none";
	return PERSONAS.map((p) => `${p.name} (${p.description})`).join("; ");
}

// ---------------------------------------------------------------------------
// Child process plumbing
// ---------------------------------------------------------------------------

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: "pi", args };
	}

	return { command: process.execPath, args };
}

function writeTempPrompt(name: string, prompt: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-egm-"));
	const safe = name.replace(/[^a-z0-9_-]/gi, "-").slice(0, 40);
	const filePath = path.join(dir, `${safe}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

function textOf(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
}

function truncate(text: string): string {
	if (Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text;
	return `${text.slice(0, MAX_OUTPUT_BYTES)}\n\n[output truncated]`;
}

interface RunOptions {
	persona: Persona;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	signal?: AbortSignal;
	onPartial?: (text: string) => void;
}

async function runReviewer(options: RunOptions): Promise<RunResult> {
	const { persona, task, cwd, model, thinkingLevel, signal, onPartial } = options;

	const result: RunResult = {
		agent: persona.name,
		task,
		exitCode: 0,
		text: "",
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		model,
	};

	const args = ["--mode", "json", "-p", "--no-session", "--tools", READ_ONLY_TOOLS.join(",")];
	if (model) args.push("--model", model);
	if (thinkingLevel) args.push("--thinking", thinkingLevel);

	let promptFile: string | null = null;

	try {
		promptFile = writeTempPrompt(persona.name, persona.systemPrompt);
		args.push("--append-system-prompt", promptFile);
		args.push(`Task: ${task}`);

		let aborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = piInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";
			let lastAssistantText = "";

			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type !== "message_end" || !event.message) return;
				const message = event.message;

				if (message.role === "assistant") {
					result.usage.turns += 1;
					const usage = message.usage;
					if (usage) {
						result.usage.input += usage.input ?? 0;
						result.usage.output += usage.output ?? 0;
						result.usage.cacheRead += usage.cacheRead ?? 0;
						result.usage.cacheWrite += usage.cacheWrite ?? 0;
						result.usage.cost += usage.cost?.total ?? 0;
					}
					if (!result.model && message.model) result.model = message.model;
					if (message.stopReason) result.stopReason = message.stopReason;
					if (message.errorMessage) result.errorMessage = message.errorMessage;

					const text = textOf(message);
					if (text.trim()) {
						lastAssistantText = text;
						onPartial?.(truncate(text));
					}
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) handleLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) handleLine(buffer);
				result.text = lastAssistantText;
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				result.stderr += `\n${error.message}`;
				resolve(1);
			});

			if (signal) {
				const kill = () => {
					aborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (aborted) throw new Error("reviewer aborted");
		return result;
	} finally {
		if (promptFile) {
			try {
				fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;

	const worker = async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function formatResult(result: RunResult): string {
	const header = `### ${result.agent}`;
	const body = truncate(result.text).trim();
	const failures = [
		result.errorMessage ? `error: ${result.errorMessage}` : "",
		result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
	]
		.filter(Boolean)
		.join("\n\n");

	if (result.exitCode !== 0 || !body) {
		const reason = result.stopReason && result.stopReason !== "end" ? result.stopReason : "failed";
		return `${header} — ${reason}\n\n${failures || "(no output)"}`;
	}

	return failures ? `${header}\n\n${body}\n\n${failures}` : `${header}\n\n${body}`;
}

function isFailed(result: RunResult): boolean {
	return result.exitCode !== 0 || !result.text.trim();
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "EGM persona name, for example egm-comprehension" }),
	task: Type.String({ description: "The review task, passed verbatim to the fresh-context reviewer" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the reviewer (defaults to the session cwd)" })),
});

export default function egmExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;
		sections.egm = [
			"The Elephant-Goldfish Model (EGM) pi adapter is installed.",
			`- EGM plugin root: ${EGM_ROOT}`,
			"- EGM skill commands: /skill:egm-brainstorm, /skill:egm-draft, /skill:egm-review,",
			"  /skill:egm-review-loop, /skill:egm-resolve, /skill:egm-bootstrap, /skill:egm-drift-report.",
			"- Paths written inside EGM skills, such as `agents/<file>.md`,",
			"  `resources/document_standards/<file>.md`, and `../../docs/<file>.md`, are relative to the",
			"  EGM plugin root above, not to the project working directory.",
			"- The harness subagent tool is pi's `subagent` tool: {agent, task} for one reviewer,",
			"  {tasks: [{agent, task}, ...]} for parallel reviewers. Reviewers run in a separate pi",
			"  process with no conversation history and read-only tools (read, grep, find, ls).",
			"- Do not substitute a reviewer run in the main context for a Goldfish review. If the",
			"  `subagent` tool is unavailable, stop and tell the user.",
			"- pi has no artifact directory: EGM briefs, drafts, and reports go to the project working",
			"  directory, unless AGENTS.md names another folder.",
			"- Ignore EGM instructions aimed at other harnesses: Antigravity (`invoke_subagent`),",
			"  Claude Code (`Agent` tool, `${CLAUDE_PLUGIN_ROOT}`, docs/claude.md), Codex/ChatGPT",
			"  (`spawn_agent`, docs/codex.md), omp, and Muse.",
			`- Reviewer personas: ${PERSONAS.map((p) => p.name).join(", ") || "none loaded"}.`,
		].join("\n");
	});

	pi.registerTool({
		name: "subagent",
		label: "Reviewer subagent",
		description: [
			"Delegate a task to a fresh-context EGM Goldfish reviewer.",
			"Each reviewer runs in a separate pi process with no access to this conversation and with",
			"read-only tools (read, grep, find, ls).",
			"Modes: single {agent, task}; parallel {tasks: [{agent, task}, ...]}.",
			`Available agents: ${personaList()}.`,
		].join(" "),
		promptSnippet: "Run fresh-context EGM reviewers (read-only) on a document or design",
		promptGuidelines: [
			"Use the subagent tool to delegate EGM Goldfish reviews; pass the reviewer task verbatim and do not summarize it away.",
			"Use the subagent tool with the tasks array to run independent reviewers in parallel instead of reviewing in the main context.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Persona name (single mode)" })),
			task: Type.Optional(Type.String({ description: "Review task (single mode)" })),
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel reviewer tasks" })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the reviewer (single mode)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);

			if (Number(hasTasks) + Number(hasSingle) !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one mode: {agent, task} or {tasks: [...]}.\nAvailable agents: ${personaList()}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const dispatch = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};

			const resolvePersona = (name: string) => PERSONAS.find((p) => p.name === name);

			if (hasTasks) {
				const tasks = params.tasks!;
				if (tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel reviewers (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: {},
						isError: true,
					};
				}

				const unknown = tasks.map((t) => t.agent).filter((name) => !resolvePersona(name));
				if (unknown.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown agent(s): ${unknown.join(", ")}. Available agents: ${personaList()}`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, async (item) => {
					const persona = resolvePersona(item.agent)!;
					const result = await runReviewer({
						persona,
						task: item.task,
						cwd: item.cwd ?? ctx.cwd,
						model: persona.model ?? REVIEWER_MODEL ?? dispatch.model,
						thinkingLevel: dispatch.thinkingLevel,
						signal,
						onPartial: (text) => {
							onUpdate?.({
								content: [{ type: "text", text: `[${item.agent}] ${text}` }],
								details: { running: item.agent },
							});
						},
					});
					return result;
				});

				const failed = results.filter(isFailed).length;
				const summary = results.map(formatResult).join("\n\n---\n\n");
				return {
					content: [
						{
							type: "text",
							text: `Parallel review: ${results.length - failed}/${results.length} completed.\n\n${summary}`,
						},
					],
					details: { results: results.map((r) => ({ agent: r.agent, exitCode: r.exitCode, usage: r.usage })) },
					isError: failed === results.length,
				};
			}

			const persona = resolvePersona(params.agent!);
			if (!persona) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent: ${params.agent}. Available agents: ${personaList()}`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const result = await runReviewer({
				persona,
				task: params.task!,
				cwd: params.cwd ?? ctx.cwd,
				model: persona.model ?? REVIEWER_MODEL ?? dispatch.model,
				thinkingLevel: dispatch.thinkingLevel,
				signal,
				onPartial: (text) => {
					onUpdate?.({ content: [{ type: "text", text }], details: { running: persona.name } });
				},
			});

			return {
				content: [{ type: "text", text: truncate(result.text).trim() || "(no output)" }],
				details: { agent: result.agent, exitCode: result.exitCode, usage: result.usage },
				isError: isFailed(result),
			};
		},
	});
}

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

export const TEST_ROOT = "https://tsgw-host-test.invalid";
export const TEST_KEY = "host-regression-dummy-not-a-real-key";

export interface CapturedRequest {
	body: Record<string, unknown>;
	headers: Headers;
}

/** Only HTTP is faked: Pi's loader, registry, session, runner and adapters stay real. */
export class HostSandbox {
	readonly root = mkdtempSync(join(tmpdir(), "pi-tsgw-host-"));
	readonly cwd = join(this.root, "workspace");
	readonly agentDir = join(this.root, "agent");
	readonly requests: CapturedRequest[] = [];
	readonly blocked: string[] = [];
	catalogIds: string[] = [];
	catalogCalls = 0;
	catalogFails = false;
	private readonly env = { ...process.env };
	private readonly originalCwd = process.cwd();
	private readonly originalFetch = globalThis.fetch;
	private readonly connect = net.Socket.prototype.connect;
	private readonly tlsConnect = tls.connect;
	private readonly createSocket = dgram.createSocket;

	constructor() {
		mkdirSync(this.cwd);
		mkdirSync(this.agentDir);
		// Clear ALL ambient provider keys, cloud credentials and Pi resource overrides.
		// Import the SDK only after installing this environment and network guard.
		for (const name of Object.keys(process.env)) delete process.env[name];
		Object.assign(process.env, {
			PATH: this.env.PATH ?? "",
			HOME: this.root,
			USERPROFILE: this.root,
			XDG_CONFIG_HOME: join(this.root, "config"),
			XDG_CACHE_HOME: join(this.root, "cache"),
			PI_CODING_AGENT_DIR: this.agentDir,
			AWS_EC2_METADATA_DISABLED: "true",
		});
		process.chdir(this.cwd);
		const deny = (): never => {
			this.blocked.push("socket");
			throw new Error("Host regression forbids real network sockets");
		};
		net.Socket.prototype.connect = deny;
		tls.connect = deny;
		dgram.createSocket = deny;
		syncBuiltinESMExports();
		globalThis.fetch = this.fetch;
	}

	private fetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin !== TEST_ROOT || !["/v1/models", "/v1/responses"].includes(url.pathname)) {
			this.blocked.push(`${request.method} ${url.origin}${url.pathname}`);
			throw new Error("Unexpected HTTP request in isolated host regression");
		}
		assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
		if (url.pathname === "/v1/models") {
			assert.equal(request.method, "GET");
			this.catalogCalls++;
			if (this.catalogFails) return new Response("fixture unavailable", { status: 503 });
			return Response.json({ data: this.catalogIds.map((id) => ({ id })) });
		}
		assert.equal(request.method, "POST");
		this.requests.push({ body: await request.json() as Record<string, unknown>, headers: request.headers });
		return responsesSse();
	};

	restore(): void {
		globalThis.fetch = this.originalFetch;
		net.Socket.prototype.connect = this.connect;
		tls.connect = this.tlsConnect;
		dgram.createSocket = this.createSocket;
		syncBuiltinESMExports();
		process.chdir(this.originalCwd);
		for (const name of Object.keys(process.env)) delete process.env[name];
		Object.assign(process.env, this.env);
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** Minimal genuine Responses wire stream consumed by Pi's built-in adapter. */
function responsesSse(): Response {
	const item = {
		id: "msg_fixture", type: "message", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: "fixture reply", annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "fixture reply" },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: {
			id: "resp_fixture", status: "completed", output: [item],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
		} },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

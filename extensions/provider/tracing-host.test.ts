import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type {
	AgentSession,
	ExtensionError,
	SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import {
	HostSandbox,
	TEST_KEY,
	TEST_ROOT,
} from "#tsgw/host-test-support.test";
import { modelsForRoot, PROVIDER_ID } from "#tsgw/models/catalog";
import { registerGatewayTracing } from "./tracing.ts";

const MODEL_ID = "deepseek-flash";
const FIXTURE_MODELS = modelsForRoot(TEST_ROOT, {
	include: [MODEL_ID],
	exclude: ["*"],
});
const OTHER_MODEL = {
	...FIXTURE_MODELS[0]!,
	id: "tracing-other",
	name: "Tracing other",
};

/** 当前 branch 上最近一条真实用户消息 entry；与 tracing.ts 的公开身份来源一致。 */
function latestUserEntryId(session: AgentSession): string {
	const entry = [...session.sessionManager.getBranch()]
		.reverse()
		.find(entry => entry.type === "message" && entry.message.role === "user");
	assert.ok(entry, "当前会话必须存在真实用户消息 entry");
	return entry.id;
}

/**
 * 真实 Pi SDK、SessionManager、ModelRuntime 与扩展运行器；只有 HTTP 由 HostSandbox
 * 提供受控 Responses 夹具。追踪实现只注册 registerGatewayTracing，不复制业务逻辑。
 */
test(
	"真实宿主：网关追踪头绑定真实会话与用户消息 entry",
	{ timeout: 60_000 },
	async () => {
		const sandbox = new HostSandbox();
		const sessions: AgentSession[] = [];
		try {
			const {
				createAgentSession,
				DefaultResourceLoader,
				ModelRuntime,
				SessionManager,
				SettingsManager,
			} = await import("@earendil-works/pi-coding-agent");
			const settings = SettingsManager.inMemory({
				packages: [],
				extensions: [],
				compaction: { enabled: true, keepRecentTokens: 0 },
				// 关闭会话级自动重试，只保留传输级一次重试用于下面的稳定性断言。
				retry: {
					enabled: false, maxRetries: 0,
					provider: { maxRetries: 1, maxRetryDelayMs: 0 },
				},
				cacheWarming: "off",
				transport: "sse",
			});
			const loader = new DefaultResourceLoader({
				cwd: sandbox.cwd, agentDir: sandbox.agentDir,
				settingsManager: settings,
				noSkills: true, noPromptTemplates: true, noThemes: true,
				noContextFiles: true,
				systemPrompt: "隔离网关追踪头回归测试。",
				extensionFactories: [pi => {
					pi.registerProvider(PROVIDER_ID, {
						name: "TSGW tracing fixture",
						baseUrl: `${TEST_ROOT}/v1`,
						api: "openai-responses",
						apiKey: TEST_KEY,
						models: [...FIXTURE_MODELS,
							{ ...FIXTURE_MODELS[0]!, id: "fixture-completions", api: "openai-completions", reasoning: false },
							{ ...FIXTURE_MODELS[0]!, id: "fixture-messages", api: "anthropic-messages", baseUrl: `${TEST_ROOT}/anthropic`, reasoning: false },
						],
					});
					pi.registerProvider("tracing-other", {
						baseUrl: `${TEST_ROOT}/v1`,
						api: "openai-responses",
						apiKey: TEST_KEY,
						models: [OTHER_MODEL],
					});
					registerGatewayTracing(pi, TEST_ROOT);
					pi.on("before_agent_start", () => ({ message: {
						customType: "synthetic-context", content: "合成附加上下文", display: false,
					} }));
				}],
			});
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			const runtime = await ModelRuntime.create({
				authPath: join(sandbox.agentDir, "auth.json"),
				modelsPath: join(sandbox.agentDir, "models.json"),
				modelsStorePath: join(sandbox.agentDir, "models-store.json"),
				refreshOnCreate: false, allowModelNetwork: false,
			});
			await runtime.setRuntimeApiKey(PROVIDER_ID, TEST_KEY);
			await runtime.setRuntimeApiKey("tracing-other", TEST_KEY);
			const model = () => {
				const found = runtime.getModel(PROVIDER_ID, MODEL_ID);
				assert.ok(found, "必须登记受控聊天模型");
				return found;
			};
			const open = async (
				sessionManager: SessionManagerType,
			): Promise<{ session: AgentSession; errors: ExtensionError[] }> => {
				const errors: ExtensionError[] = [];
				const { session } = await createAgentSession({
					cwd: sandbox.cwd, agentDir: sandbox.agentDir,
					modelRuntime: runtime, resourceLoader: loader,
					settingsManager: settings, sessionManager,
					tools: [], thinkingLevel: "off",
				});
				sessions.push(session);
				await session.setModel(model());
				await session.bindExtensions({
					mode: "print",
					onError: error => { errors.push(error); },
				});
				return { session, errors };
			};

			// 1. 两轮真实请求：thread 稳定，trace 分别指向真实的用户消息 entry。
			const persistedDir = join(sandbox.root, "sessions");
			const { session, errors } = await open(
				SessionManager.create(sandbox.cwd, persistedDir),
			);
			const sessionId = session.sessionManager.getSessionId();
			assert.ok(sessionId, "真实 SessionManager 必须给出会话 ID");
			const preflight: Record<string, string | null> = {};
			await session.extensionRunner.emitBeforeProviderHeaders(preflight);
			assert.deepEqual(preflight, {
				"AH-Thread-Id": sessionId,
				"X-Magpie-Session": sessionId,
			}, "没有用户消息时只能关联会话，不能伪造 trace");

			// 同名头大小写不敏感，存在即不覆盖（包括显式 null）。
			const preserved: Record<string, string | null> = {
				"ah-thread-id": "keep-thread",
				"X-MAGPIE-SESSION": null,
			};
			await session.extensionRunner.emitBeforeProviderHeaders(preserved);
			assert.deepEqual(preserved, {
				"ah-thread-id": "keep-thread",
				"X-MAGPIE-SESSION": null,
			});

			// 非 tsgw provider 即使指向同一 origin 也不补头。
			const other = runtime.getModel("tracing-other", OTHER_MODEL.id);
			assert.ok(other, "必须登记非 tsgw 对照模型");
			await session.setModel(other);
			const foreign: Record<string, string | null> = {};
			await session.extensionRunner.emitBeforeProviderHeaders(foreign);
			assert.deepEqual(foreign, {});
			await session.setModel(model());

			await session.prompt("第一轮追踪回归");
			assert.equal(sandbox.requests.length, 1);
			const first = sandbox.requests[0]!;
			const firstUser = latestUserEntryId(session);
			assert.equal(first.headers.get("AH-Thread-Id"), sessionId);
			assert.equal(first.headers.get("X-Magpie-Session"), sessionId);
			assert.equal(first.headers.get("AH-Trace-Id"), `${sessionId}.${firstUser}`);

			// 正常 chat 期间已存在的 trace 头同样不覆盖。
			await session.extensionRunner.emit({ type: "agent_start" });
			const preservedTrace: Record<string, string | null> = {
				"ah-trace-id": "keep-trace",
			};
			await session.extensionRunner.emitBeforeProviderHeaders(preservedTrace);
			assert.deepEqual(preservedTrace, {
				"ah-trace-id": "keep-trace",
				"AH-Thread-Id": sessionId,
				"X-Magpie-Session": sessionId,
			});
			await session.extensionRunner.emit({ type: "agent_end", messages: [] });

			await session.prompt("第二轮追踪回归");
			assert.equal(sandbox.requests.length, 2);
			const second = sandbox.requests[1]!;
			const secondUser = latestUserEntryId(session);
			assert.notEqual(secondUser, firstUser);
			assert.equal(second.headers.get("AH-Thread-Id"), sessionId);
			assert.equal(second.headers.get("X-Magpie-Session"), sessionId);
			assert.equal(second.headers.get("AH-Trace-Id"), `${sessionId}.${secondUser}`);
			assert.notEqual(
				second.headers.get("AH-Trace-Id"),
				first.headers.get("AH-Trace-Id"),
			);
			assert.deepEqual(errors, []);

			// 2. reload 保持真实会话 ID；旧运行器 shutdown 后不再补头。
			const oldRunner = session.extensionRunner;
			await session.reload();
			assert.equal(session.sessionManager.getSessionId(), sessionId);
			const late: Record<string, string | null> = {};
			await oldRunner.emitBeforeProviderHeaders(late);
			assert.deepEqual(late, {}, "失效运行器不得在 shutdown 后补头");
			await session.setModel(model());
			await session.prompt("reload 后追踪回归");
			const afterReload = sandbox.requests.at(-1)!;
			assert.equal(afterReload.headers.get("AH-Thread-Id"), sessionId);
			assert.equal(afterReload.headers.get("X-Magpie-Session"), sessionId);
			assert.equal(
				afterReload.headers.get("AH-Trace-Id"),
				`${sessionId}.${latestUserEntryId(session)}`,
			);
			assert.notEqual(
				afterReload.headers.get("AH-Trace-Id"),
				second.headers.get("AH-Trace-Id"),
			);
			assert.deepEqual(errors, []);

			// 3. 持久文件重新 open：仍是同一个会话身份，新的用户消息使用新的 trace。
			const sessionFile = session.sessionFile;
			assert.ok(sessionFile, "持久会话必须写盘");
			const reopenedManager = SessionManager.open(sessionFile);
			assert.equal(reopenedManager.getSessionId(), sessionId);
			session.dispose();
			const { session: resumed, errors: resumedErrors } =
				await open(reopenedManager);
			await resumed.prompt("恢复会话后的追踪回归");
			const resumedRequest = sandbox.requests.at(-1)!;
			assert.equal(resumedRequest.headers.get("AH-Thread-Id"), sessionId);
			assert.equal(resumedRequest.headers.get("X-Magpie-Session"), sessionId);
			assert.equal(
				resumedRequest.headers.get("AH-Trace-Id"),
				`${sessionId}.${latestUserEntryId(resumed)}`,
			);
			assert.deepEqual(resumedErrors, []);

			// 4. 两个新会话（其中一个记录 parentSession）身份互不影响。
			const withParent = SessionManager.inMemory(sandbox.cwd);
			withParent.newSession({ parentSession: sessionFile });
			assert.equal(withParent.getHeader()?.parentSession, sessionFile);
			const { session: childA, errors: errorsA } = await open(withParent);
			const { session: childB, errors: errorsB } =
				await open(SessionManager.inMemory(sandbox.cwd));
			const idA = childA.sessionManager.getSessionId();
			const idB = childB.sessionManager.getSessionId();
			assert.notEqual(idA, idB);
			assert.notEqual(idA, sessionId);
			assert.notEqual(idB, sessionId);

			await childA.prompt("子会话 A 追踪回归");
			const requestA = sandbox.requests.at(-1)!;
			assert.equal(requestA.headers.get("AH-Thread-Id"), idA);
			assert.equal(requestA.headers.get("X-Magpie-Session"), idA);
			assert.equal(
				requestA.headers.get("AH-Trace-Id"),
				`${idA}.${latestUserEntryId(childA)}`,
			);

			await childB.prompt("子会话 B 追踪回归");
			const requestB = sandbox.requests.at(-1)!;
			assert.equal(requestB.headers.get("AH-Thread-Id"), idB);
			assert.equal(requestB.headers.get("X-Magpie-Session"), idB);
			assert.equal(
				requestB.headers.get("AH-Trace-Id"),
				`${idB}.${latestUserEntryId(childB)}`,
			);
			assert.deepEqual([...errorsA, ...errorsB], []);

			// 5. 同一条用户消息的传输级重试不得拆出新的 trace。
			const baseFetch = globalThis.fetch;
			const attempts: Headers[] = [];
			let firstAttempt = true;
			globalThis.fetch = async (input, init) => {
				const request = input instanceof Request
					? input
					: new Request(input, init);
				if (new URL(request.url).pathname === "/v1/responses") {
					attempts.push(request.headers);
					if (firstAttempt) {
						firstAttempt = false;
						return new Response("synthetic transient", {
							status: 503,
							headers: { "retry-after-ms": "0" },
						});
					}
				}
				return baseFetch(input, init);
			};
			try {
				const beforeRetry = sandbox.requests.length;
				await childB.prompt("同消息重试追踪回归");
				assert.equal(attempts.length, 2, "必须发生一次传输级重试");
				assert.equal(sandbox.requests.length, beforeRetry + 1);
				const retryTrace = `${idB}.${latestUserEntryId(childB)}`;
				for (const headers of attempts)
					assert.equal(headers.get("AH-Trace-Id"), retryTrace);
				assert.equal(
					sandbox.requests.at(-1)!.headers.get("AH-Trace-Id"),
					retryTrace,
				);
			} finally {
				globalThis.fetch = baseFetch;
			}

			// 6. 同一run中的steer/follow-up入库后使用各自真实用户消息身份。
			for (const delivery of ["steer", "followUp"] as const) {
				const guardedFetch = globalThis.fetch;
				const observed: { headers: Headers; entryId: string }[] = [];
				globalThis.fetch = async (input, init) => {
					const request = new Request(input, init);
					if (new URL(request.url).pathname === "/v1/responses") {
						observed.push({ headers: request.headers, entryId: latestUserEntryId(childB) });
						if (observed.length === 1) await childB[delivery]("合成队列输入");
					}
					return guardedFetch(input, init);
				};
				try {
					await childB.prompt("合成队列追踪回归");
					assert.equal(observed.length, 2);
					assert.notEqual(observed[0]!.entryId, observed[1]!.entryId);
					for (const item of observed)
						assert.equal(item.headers.get("AH-Trace-Id"), `${idB}.${item.entryId}`);
				} finally { globalThis.fetch = guardedFetch; }
			}

			// 7. 压缩摘要只关联会话，不伪装成用户消息 trace。
			const summaryBefore = sandbox.requests.length;
			await childA.compact();
			// split turn 可分别请求历史摘要与本轮前缀摘要，两者都不能借用用户 trace。
			const summaries = sandbox.requests.slice(summaryBefore);
			assert.ok(summaries.length > 0);
			for (const summary of summaries) {
				assert.equal(summary.headers.get("AH-Thread-Id"), idA);
				assert.equal(summary.headers.get("X-Magpie-Session"), idA);
				assert.equal(summary.headers.get("AH-Trace-Id"), null);
			}
			assert.deepEqual([...errorsA, ...errorsB], []);

			// 8. 真实 Completions / Messages 适配器同样收到动态追踪头。
			for (const [modelId, path] of [
				["fixture-completions", "/v1/chat/completions"],
				["fixture-messages", "/anthropic/v1/messages"],
			] as const) {
				const protocolModel = runtime.getModel(PROVIDER_ID, modelId);
				assert.ok(protocolModel);
				await childA.setModel(protocolModel);
				const captured: Headers[] = [];
				const guardedFetch = globalThis.fetch;
				globalThis.fetch = async (input, init) => {
					const request = new Request(input, init);
					const url = new URL(request.url);
					if (url.origin !== TEST_ROOT || url.pathname !== path) return guardedFetch(input, init);
					captured.push(request.headers);
					const events = modelId === "fixture-completions" ? [
						{ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
						{ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					] : [
						{ type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: modelId, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "OK" } },
						{ type: "content_block_stop", index: 0 },
						{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
						{ type: "message_stop" },
					];
					return new Response(events.map(event =>
						`${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
					).join(""), { headers: { "content-type": "text/event-stream" } });
				};
				try {
					await childA.prompt("跨协议追踪回归");
					assert.deepEqual(sandbox.blocked, []);
					const reply = childA.messages.at(-1);
					assert.ok(reply?.role === "assistant");
					assert.notEqual(reply.stopReason, "error", `${modelId}: ${reply.errorMessage}`);
					assert.equal(childA.getLastAssistantText(), "OK");
					assert.equal(captured.length, 1);
					assert.equal(captured[0]!.get("AH-Thread-Id"), idA);
					assert.equal(captured[0]!.get("X-Magpie-Session"), idA);
					assert.equal(captured[0]!.get("AH-Trace-Id"), `${idA}.${latestUserEntryId(childA)}`);
				} finally { globalThis.fetch = guardedFetch; }
			}
			assert.deepEqual(errorsA, []);

			// 9. 显式 shutdown 后同一运行器不再补头。
			await childB.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			const afterShutdown: Record<string, string | null> = {};
			await childB.extensionRunner.emitBeforeProviderHeaders(afterShutdown);
			assert.deepEqual(afterShutdown, {});
			assert.deepEqual(sandbox.blocked, []);
		} finally {
			for (const session of sessions) {
				try { session.dispose(); } catch { /* 已释放 */ }
			}
			sandbox.restore();
		}
	},
);

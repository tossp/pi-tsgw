import { PROVIDER_ID } from "#tsgw/models/catalog";

export const CATALOG_RECOVERY_WINDOW_MS = 60_000;
export const CATALOG_RECOVERY_DELAY_MS = 5_000;

export interface CatalogRefreshResult {
	aborted?: boolean;
	errors?: ReadonlyMap<string, Error>;
}

/** 仅保存宿主服务，不保存会话 context；一次恢复最多一分钟，没有常驻轮询。 */
export function createCatalogRecovery(options: {
	needsRefresh(): boolean;
	retryable(): boolean;
	networkAttempted(): boolean;
	onFailure(): void;
}) {
	let active: {
		controller: AbortController;
		deadline?: ReturnType<typeof setTimeout>;
		wake?: ReturnType<typeof setTimeout>;
		cancelWait?: () => void;
	} | undefined;

	const stop = (): void => {
		const task = active;
		if (!task) return;
		active = undefined;
		clearTimeout(task.deadline);
		clearTimeout(task.wake);
		task.cancelWait?.();
		task.controller.abort();
	};

	return {
		stop,
		start(service: {
			configured(): boolean;
			restore?(signal: AbortSignal): Promise<CatalogRefreshResult | void>;
			refresh(signal: AbortSignal): Promise<CatalogRefreshResult | void>;
		}): void {
			stop();
			const task: NonNullable<typeof active> = { controller: new AbortController() };
			active = task;
			// 截止仍未恢复时才告警；通知异常也要吞掉并继续清理，且 stop 保证只告警一次。
			const fail = (): void => {
				if (active !== task) return;
				try {
					options.onFailure();
				} catch {
					/* 宿主通知失败也必须继续清理。 */
				} finally {
					stop();
				}
			};
			// 整轮（含 restore 与所有等待）共享同一个一分钟截止。
			task.deadline = setTimeout(fail, CATALOG_RECOVERY_WINDOW_MS);
			task.deadline.unref?.();
			const wait = (ms: number): Promise<void> => new Promise(resolve => {
				task.cancelWait = resolve;
				task.wake = setTimeout(() => { task.cancelWait = undefined; resolve(); }, ms);
				task.wake.unref?.();
			});
			void (async () => {
				// 让 session_start 先返回，不把请求挂在宿主启动链上。
				await wait(0);
				// 先同步本地快照（含另一会话写入的新磁盘缓存），此阶段绝不发起网络请求。
				while (active === task && service.restore) {
					let retry = false;
					try {
						const restored = await service.restore(task.controller.signal);
						// aborted 或 tsgw 错误都代表本次恢复未成功，不提前告警。
						retry = !!restored?.aborted || !!restored?.errors?.has(PROVIDER_ID);
					} catch {
						if (active !== task) return;
						// 恢复抛错与 aborted 一样，在同一截止窗口内短间隔重试，不提前 Toast。
						retry = true;
					}
					if (active !== task) return;
					if (!retry) break;
					await wait(CATALOG_RECOVERY_DELAY_MS);
				}
				if (active !== task) return;
				if (!service.configured()) { fail(); return; }
				if (!options.needsRefresh()) { stop(); return; }
				while (active === task) {
					let failed = false;
					try {
						const result = await service.refresh(task.controller.signal);
						if (active !== task) return;
						// 宿主刷新互相取代不等于恢复成功；未结束本轮时仍可继续。
						failed = !!result?.aborted || !!result?.errors?.has(PROVIDER_ID) || options.needsRefresh();
						// 宿主禁止联网（如离线模式）时，不绕过许可，也不反复重试。
						if (!result?.aborted && !result?.errors?.has(PROVIDER_ID) &&
							options.needsRefresh() && !options.networkAttempted()) { stop(); return; }
					} catch {
						if (active !== task) return;
						failed = true;
					}
					if (!failed) { stop(); return; }
					if (!service.configured() || !options.retryable()) { fail(); return; }
					await wait(CATALOG_RECOVERY_DELAY_MS);
				}
			})().catch(() => { fail(); });
		},
	};
}

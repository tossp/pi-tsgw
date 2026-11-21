import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isPlainObject, PayloadWriter } from "#tsgw/models/_tools";
import { glmThinking } from "#tsgw/models/vendors/glm";
import { DELEGATION_KINDS, type DelegationCandidate } from "./policy.ts";

export interface SelectionChannel {
	modelId: string;
	reasoning?: SimpleStreamOptions["reasoning"];
	preparePayload: (writer: PayloadWriter, model: Model<Api>, candidates: readonly DelegationCandidate[]) => void;
}

const hy4Flash: SelectionChannel = {
	modelId: "hy4-flash",
	preparePayload(writer, _model, candidates) {
		// 宿主省略关闭思考时的 effort，混元需要显式设置。
		writer.set("reasoning_effort", "no_think");
		writer.set("response_format", { type: "json_schema", json_schema: selectionSchema(candidates) });
	},
};

const deepseekFlash: SelectionChannel = {
	modelId: "deepseek-flash",
	reasoning: "low",
	preparePayload(writer, _model, candidates) {
		const text = writer.get("text");
		writer.set("text", {
			...(isPlainObject(text) ? text : {}),
			format: { type: "json_schema", ...selectionSchema(candidates) },
		});
	},
};

const glm53Flash: SelectionChannel = {
	modelId: "glm-5.3-flash",
	reasoning: "low",
	preparePayload(writer, model) {
		glmThinking[model.id](writer, { provider: model.provider, modelId: model.id, api: model.api,
			thinkingLevel: "low", tsSearchMode: "cached" });
	},
};

export const SELECTION_CHANNELS = {
	primary: hy4Flash,
	primaryTimeoutMs: 7_000,
	backups: [deepseekFlash, glm53Flash],
};

function selectionSchema(candidates: readonly DelegationCandidate[]) {
	return {
		name: "delegation_selection", strict: true,
		schema: {
			type: "object",
			properties: {
				kind: { type: "string", enum: [...DELEGATION_KINDS] },
				selection: { type: "string", enum: [...candidates.map(candidate => candidate.key), "unresolved"] },
			},
			required: ["kind", "selection"], additionalProperties: false,
		},
	};
}

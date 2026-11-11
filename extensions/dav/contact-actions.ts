import type { Contact, FirstContactProperties } from "davkit/vcard";
import type { ContactCreateInput, ContactDeleteInput, ContactSearchInput, ContactUpdateInput } from "./contact-action-schema.ts";
import { contactSummary, decodedValues, tryReadContact, unresolvedContact } from "./contacts.ts";
import { assertManagedMetadata, assertValidContent } from "./content.ts";
import { contentOperation, createResourceUrl, getVersionedResource, utcStamp } from "./mutations.ts";
import { revisionRepairEdit } from "./revision-repair.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const searchFields = new Set(["FN", "N", "NICKNAME", "TITLE", "ROLE", "ORG", "NOTE", "EMAIL", "TEL"]);
const contentType = "text/vcard; charset=utf-8";

function readContact(context: DavReadContext, raw: string): Contact {
	return contentOperation(() => context.vcard.parseContact(raw), "DATA_INVALID");
}

/** 旧编辑器尚未生成候选时拒绝，不冒充最终校验已执行。 */
function editContact<T>(operation: () => T, details: Record<string, unknown>, sourceInvalid = false): T {
	try { return operation(); }
	catch (error) {
		if (error instanceof DavToolError) throw error;
		throw new DavToolError(sourceInvalid ? "REPAIR_UNSUPPORTED" : "INVALID_INPUT",
			sourceInvalid ? "现有编辑能力不能表达此源内容的修正，尚未生成最终候选，未执行写入。"
				: "内容或字段组合无效，尚未生成最终候选，未执行写入。",
			{ ...details, stage: "edit" });
	}
}

/** 与旧搜索一致：只接受数字、空白和常用电话标点，不扩展 URI 或分机解析。 */
function phoneDigits(value: string): string {
	return /^[0-9\s+()./\-]*$/u.test(value) ? value.replace(/[^0-9]/g, "") : "";
}

export async function searchContacts(context: DavReadContext, input: ContactSearchInput) {
	if (!input.query.trim()) throw new DavToolError("INVALID_INPUT", "联系人搜索词不能为空或仅含空白。");
	const query = input.query.toLowerCase();
	const digits = phoneDigits(query);
	const resources = await context.client.query(input.collectionUrl, "addressbook");
	const items: ReturnType<typeof contactSummary>[] = [];
	const unresolvedResources: ReturnType<typeof unresolvedContact>[] = [];
	for (const resource of resources) {
		const contact = tryReadContact(context, resource.data);
		if (!contact) { unresolvedResources.push(unresolvedContact(context, resource, "report", "parse", undefined, "unknown")); continue; }
		const fields = contact.properties.filter(property => searchFields.has(property.name));
		const matched = fields.some(property => decodedValues(property)?.some(value => value.toLowerCase().includes(query) ||
			(property.name === "TEL" && digits !== "" && phoneDigits(value.toLowerCase().replace(/^tel:/, "")).includes(digits))));
		if (!matched) {
			if (fields.some(property => decodedValues(property) === undefined))
				unresolvedResources.push(unresolvedContact(context, resource, "report", "search", contact, "unknown"));
			continue;
		}
		const summary = contactSummary(contact, resource);
		if (summary.emails === undefined || summary.phones === undefined)
			unresolvedResources.push(unresolvedContact(context, resource, "report", "projection", contact, "matched"));
		else items.push(summary);
	}
	return { account: input.account, collectionUrl: input.collectionUrl,
		resourcesComplete: true, complete: unresolvedResources.length === 0, items, unresolvedResources };
}

function firstProperties(input: ContactCreateInput | ContactUpdateInput): FirstContactProperties {
	return { email: input.email, tel: input.phone, org: input.org, note: input.note };
}

function checkName(name: string | undefined): void {
	if (name !== undefined && (typeof name !== "string" || !name.trim()))
		throw new DavToolError("INVALID_INPUT", "联系人显示名称不能为空或仅含空白，也不能为 null。");
}

function rejectRevision(contact: Contact): void {
	if (contact.properties.some(property => property.name === "REV"))
		throw new DavToolError("INVALID_INPUT", "REV 由工具维护，不能通过高级属性指定或删除。");
}

function checkUpdateProperties(context: DavReadContext, input: ContactUpdateInput, contact: Contact): void {
	if (input.phone !== undefined && input.phone !== null && contact.properties.find(property => property.name === "TEL")
		?.parameters.get("VALUE")?.some(value => value.toUpperCase() === "URI"))
		throw new DavToolError("INVALID_INPUT", "首项电话显式声明为 URI，不能用 phone 标量改写；请通过 properties 明确替换完整 TEL 属性，或用 null 删除首项。");
	if (input.removeProperties?.some(name => name.toUpperCase() === "REV"))
		throw new DavToolError("INVALID_INPUT", "REV 由工具维护，不能通过高级属性指定或删除。");
	// 仅用公开模型预检输入冲突与受管属性；此结果不用于源修正或发送。
	// 首项仅传操作存在性，实际值必须按源参数编辑，不能借无源探针改变 TEXT/URI 语义。
	const probe = context.vcard.buildContact({ name: "属性校验", version: contact.version });
	rejectRevision(context.vcard.parseContact(context.vcard.updateContact(probe, {
		name: input.name, properties: input.properties, removeProperties: input.removeProperties,
		firstProperties: {
			email: input.email === undefined ? undefined : null, tel: input.phone === undefined ? undefined : null,
			org: input.org === undefined ? undefined : null, note: input.note === undefined ? undefined : null,
		},
	})));
}

function checkIdentity(contact: Contact, uid: string): void {
	if (contact.uid !== uid) throw new DavToolError("NOT_FOUND", "联系人 UID 与资源不匹配，未执行写入。");
}

export async function createContact(context: DavReadContext, input: ContactCreateInput) {
	checkName(input.name);
	const raw = editContact(() => {
		const base = context.vcard.buildContact({ name: input.name, properties: input.properties });
		rejectRevision(context.vcard.parseContact(base));
		// 保留高级整组输入以便库检查其与首项字段的同名冲突。
		const changed = context.vcard.updateContact(base, { firstProperties: firstProperties(input), properties: input.properties });
		return context.vcard.updateContact(changed, { properties: [`REV:${utcStamp()}`] });
	}, { account: input.account, collectionUrl: input.collectionUrl });
	const uid = readContact(context, raw).uid!;
	const resourceUrl = createResourceUrl(input.collectionUrl, "vcf");
	assertValidContent(context.vcard.validateContact(raw), { account: input.account, resourceUrl, uid });
	context.writeIdentity = { account: input.account, uid };
	const etag = await context.client.create(resourceUrl, raw, contentType);
	return { account: input.account, resourceUrl, uid, etag, outcome: "created" as const };
}

export async function updateContact(context: DavReadContext, input: ContactUpdateInput) {
	checkName(input.name);
	const resource = await getVersionedResource(context, input);
	const result = { account: input.account, resourceUrl: resource.url, uid: input.uid };
	const contact = tryReadContact(context, resource.data);
	if (!contact) throw new DavToolError("REPAIR_UNSUPPORTED", "源内容无法可靠解析及确认身份，现有工具不能安全修正，未执行写入。",
		{ ...result, stage: "source", issues: context.vcard.validateContact(resource.data).issues });
	checkIdentity(contact, input.uid);
	const sourceValidation = context.vcard.validateContact(resource.data);
	if (input.revisionRepair === undefined) assertManagedMetadata(sourceValidation, ["REV"], result);
	const repair = input.revisionRepair === undefined ? undefined
		: revisionRepairEdit([["REV", input.revisionRepair.rev]], sourceValidation, result);
	// 输入冲突仍属于输入错误，不能借异常源内容掩盖。
	editContact(() => checkUpdateProperties(context, input, contact), result);
	const editDetails = sourceValidation.valid ? result : { ...result, sourceIssues: sourceValidation.issues };
	const changed = editContact(() => context.vcard.updateContact(resource.data, {
		name: input.name === contact.name ? undefined : input.name,
		firstProperties: firstProperties(input),
		properties: repair ? [...input.properties ?? [], ...repair.properties] : input.properties,
		removeProperties: repair ? [...input.removeProperties ?? [], ...repair.removeProperties] : input.removeProperties,
	}), editDetails, !sourceValidation.valid);
	if (repair) assertManagedMetadata(context.vcard.validateContact(changed), ["REV"], result, "repair");
	const raw = changed === resource.data ? changed : editContact(() =>
		context.vcard.updateContact(changed, { properties: [`REV:${utcStamp()}`] }), editDetails, !sourceValidation.valid);
	assertValidContent(context.vcard.validateContact(raw), result);
	if (changed === resource.data) return { ...result, etag: input.etag, outcome: "unchanged" as const };
	const etag = await context.client.update(resource.url, raw, input.etag, contentType);
	return { ...result, etag, outcome: "updated" as const };
}

export async function deleteContact(context: DavReadContext, input: ContactDeleteInput) {
	const resource = await getVersionedResource(context, input);
	checkIdentity(readContact(context, resource.data), input.uid);
	await context.client.delete(resource.url, input.etag);
	return { account: input.account, resourceUrl: resource.url, uid: input.uid, etag: input.etag, outcome: "deleted" as const };
}

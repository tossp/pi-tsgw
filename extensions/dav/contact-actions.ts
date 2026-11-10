import type { Contact, ContactProperty, FirstContactProperties } from "davkit/vcard";
import type { ContactCreateInput, ContactDeleteInput, ContactSearchInput, ContactUpdateInput } from "./contact-action-schema.ts";
import { contactSummary } from "./contacts.ts";
import { contentOperation, createResourceUrl, getVersionedResource, utcStamp } from "./mutations.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const searchFields = new Set(["FN", "N", "NICKNAME", "TITLE", "ROLE", "ORG", "NOTE", "EMAIL", "TEL"]);
const contentType = "text/vcard; charset=utf-8";

function readContact(context: DavReadContext, raw: string): Contact {
	return contentOperation(() => context.vcard.parseContact(raw), "DATA_INVALID");
}

function decodedValues(property: ContactProperty): readonly string[] {
	return property.components?.flat() ?? property.items ?? (property.value === undefined ? [] : [property.value]);
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
	// 全量解析后再匹配，不能让未匹配的坏资源被跳过。
	const parsed = resources.map(resource => ({ resource, contact: readContact(context, resource.data) }));
	const items = parsed.filter(({ contact }) => contact.properties.some(property => {
		if (!searchFields.has(property.name)) return false;
		return decodedValues(property).some(value => value.toLowerCase().includes(query) ||
			(property.name === "TEL" && digits !== "" && phoneDigits(value.toLowerCase().replace(/^tel:/, "")).includes(digits)));
	})).map(({ resource, contact }) => contactSummary(contact, resource));
	return { account: input.account, collectionUrl: input.collectionUrl, complete: true, items };
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
	if (!input.properties?.length) return;
	// 只借公开模型辨认属性；不在插件中解析用户逻辑行、分组或参数。
	const probe = context.vcard.buildContact({ name: "属性校验", version: contact.version });
	rejectRevision(context.vcard.parseContact(context.vcard.updateContact(probe, { name: input.name, properties: input.properties })));
}

function checkIdentity(contact: Contact, uid: string): void {
	if (contact.uid !== uid) throw new DavToolError("NOT_FOUND", "联系人 UID 与资源不匹配，未执行写入。");
}

export async function createContact(context: DavReadContext, input: ContactCreateInput) {
	checkName(input.name);
	const raw = contentOperation(() => {
		const base = context.vcard.buildContact({ name: input.name, properties: input.properties });
		rejectRevision(context.vcard.parseContact(base));
		// 保留高级整组输入以便库检查其与首项字段的同名冲突。
		const changed = context.vcard.updateContact(base, { firstProperties: firstProperties(input), properties: input.properties });
		return context.vcard.updateContact(changed, { properties: [`REV:${utcStamp()}`] });
	});
	const uid = readContact(context, raw).uid!;
	const resourceUrl = createResourceUrl(input.collectionUrl, "vcf");
	context.writeIdentity = { account: input.account, uid };
	const etag = await context.client.create(resourceUrl, raw, contentType);
	return { account: input.account, resourceUrl, uid, etag, outcome: "created" as const };
}

export async function updateContact(context: DavReadContext, input: ContactUpdateInput) {
	checkName(input.name);
	const resource = await getVersionedResource(context, input);
	const contact = readContact(context, resource.data);
	checkIdentity(contact, input.uid);
	const changed = contentOperation(() => {
		checkUpdateProperties(context, input, contact);
		return context.vcard.updateContact(resource.data, {
			name: input.name === contact.name ? undefined : input.name,
			firstProperties: firstProperties(input), properties: input.properties, removeProperties: input.removeProperties,
		});
	});
	const result = { account: input.account, resourceUrl: resource.url, uid: input.uid };
	if (changed === resource.data) return { ...result, etag: input.etag, outcome: "unchanged" as const };
	const raw = contentOperation(() => context.vcard.updateContact(changed, { properties: [`REV:${utcStamp()}`] }));
	const etag = await context.client.update(resource.url, raw, input.etag, contentType);
	return { ...result, etag, outcome: "updated" as const };
}

export async function deleteContact(context: DavReadContext, input: ContactDeleteInput) {
	const resource = await getVersionedResource(context, input);
	checkIdentity(readContact(context, resource.data), input.uid);
	await context.client.delete(resource.url, input.etag);
	return { account: input.account, resourceUrl: resource.url, uid: input.uid, etag: input.etag, outcome: "deleted" as const };
}

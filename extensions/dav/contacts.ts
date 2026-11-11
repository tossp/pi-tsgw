import type { DavResource } from "davkit/dav";
import type { Contact, ContactProperty } from "davkit/vcard";
import { unresolvedResource, type ReadFailureStage } from "./content.ts";
import { DavToolError, type ContactGetInput, type ContactListInput, type DavReadContext } from "./types.ts";

/** 只捕获取得正文后的解析错误；传输错误由调用方继续传播。 */
export function tryReadContact(context: DavReadContext, raw: string): Contact | undefined {
	try { return context.vcard.parseContact(raw); }
	catch { return undefined; }
}

export function decodedValues(property: ContactProperty): readonly string[] | undefined {
	return property.components?.flat() ?? property.items ?? (property.value === undefined ? undefined : [property.value]);
}

function values(contact: Contact, name: "EMAIL" | "TEL"): string[] | undefined {
	const properties = contact.properties.filter(property => property.name === name);
	// 未知首项或后续项都不能被空数组/已知子集冒充完整多值字段。
	return properties.some(property => property.value === undefined) ? undefined : properties.map(property => property.value!);
}

export function contactSummary(contact: Contact, resource: { url: string; etag: string | null }) {
	const emails = values(contact, "EMAIL");
	const phones = values(contact, "TEL");
	return {
		resourceUrl: resource.url, etag: resource.etag,
		...(contact.uid === undefined ? {} : { uid: contact.uid }),
		version: contact.version, name: contact.name,
		...(emails === undefined ? {} : { emails }),
		...(phones === undefined ? {} : { phones }),
	};
}

export function contactProperties(contact: Contact) {
	return contact.properties.map(property => ({
		name: property.name,
		...(property.group === undefined ? {} : { group: property.group }),
		parameters: Object.fromEntries(property.parameters), rawValue: property.rawValue,
		...(property.value === undefined ? {} : { value: property.value }),
		...(property.components === undefined ? {} : { components: property.components }),
		...(property.items === undefined ? {} : { items: property.items }),
	}));
}

type ContactUnresolved = ReturnType<typeof unresolvedResource> & Partial<ReturnType<typeof contactSummary>> & {
	identityConfirmed: boolean;
	properties?: ReturnType<typeof contactProperties>;
	matchStatus?: "matched" | "unknown";
};

export function unresolvedContact(
	context: DavReadContext, resource: DavResource, rawSource: "get" | "report", stage: ReadFailureStage,
	contact?: Contact, matchStatus?: "matched" | "unknown",
): ContactUnresolved {
	return {
		...unresolvedResource(resource, rawSource, stage, context.vcard.validateContact(resource.data)),
		...(contact === undefined ? {} : { ...contactSummary(contact, resource), properties: contactProperties(contact) }),
		identityConfirmed: contact !== undefined,
		...(matchStatus === undefined ? {} : { matchStatus }),
	};
}

export async function listContacts(context: DavReadContext, input: ContactListInput) {
	const resources = await context.client.query(input.collectionUrl, "addressbook");
	const items: ReturnType<typeof contactSummary>[] = [];
	const unresolvedResources: ContactUnresolved[] = [];
	for (const resource of resources) {
		const contact = tryReadContact(context, resource.data);
		if (!contact) { unresolvedResources.push(unresolvedContact(context, resource, "report", "parse")); continue; }
		const summary = contactSummary(contact, resource);
		if (summary.emails === undefined || summary.phones === undefined)
			unresolvedResources.push(unresolvedContact(context, resource, "report", "projection", contact));
		else items.push(summary);
	}
	return { account: input.account, collectionUrl: input.collectionUrl,
		resourcesComplete: true, complete: unresolvedResources.length === 0, items, unresolvedResources };
}

// 这些是详情承诺提供已解码内容的字段，不是写入规则或版本矩阵。
const detailFields = new Set(["FN", "N", "NICKNAME", "ADR", "CATEGORIES", "TITLE", "ROLE", "ORG", "NOTE", "EMAIL", "TEL"]);
type ContactDetail = Partial<ContactUnresolved> & {
	account: string; resourceUrl: string; etag: string | null; resourcesComplete: true; complete: boolean; identityConfirmed: boolean;
};

export async function getContact(context: DavReadContext, input: ContactGetInput): Promise<ContactDetail> {
	const resource = await context.client.get(input.resourceUrl);
	const identity = { account: input.account, resourceUrl: resource.url, etag: resource.etag, resourcesComplete: true as const };
	const contact = tryReadContact(context, resource.data);
	if (!contact) return { ...identity, ...unresolvedContact(context, resource, "get", "parse"), complete: false };
	if (input.uid !== undefined && contact.uid !== input.uid)
		throw new DavToolError("NOT_FOUND", "联系人 UID 与资源不匹配");
	if (contact.properties.some(property => detailFields.has(property.name) && decodedValues(property) === undefined))
		return { ...identity, ...unresolvedContact(context, resource, "get", "projection", contact), complete: false };
	return {
		...identity,
		name: contact.name, version: contact.version, identityConfirmed: true, complete: true,
		...(contact.uid === undefined ? {} : { uid: contact.uid }),
		properties: contactProperties(contact),
		...(input.raw === true ? { raw: resource.data, rawSource: "get" as const } : {}),
	};
}

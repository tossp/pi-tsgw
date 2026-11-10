import type { Contact } from "davkit/vcard";
import { DavToolError, type ContactGetInput, type ContactListInput, type DavReadContext } from "./types.ts";

function parseContact(context: DavReadContext, raw: string): Contact {
	try {
		return context.vcard.parseContact(raw);
	} catch {
		throw new DavToolError("DATA_INVALID", "联系人资源无法解析");
	}
}

function values(contact: Contact, name: "EMAIL" | "TEL"): string[] {
	return contact.properties.flatMap(property =>
		property.name === name && property.value !== undefined ? [property.value] : []);
}

export async function listContacts(context: DavReadContext, input: ContactListInput) {
	const resources = await context.client.query(input.collectionUrl, "addressbook");
	const items = resources.map(resource => {
		const contact = parseContact(context, resource.data);
		return {
			resourceUrl: resource.url,
			etag: resource.etag,
			...(contact.uid === undefined ? {} : { uid: contact.uid }),
			version: contact.version,
			name: contact.name,
			emails: values(contact, "EMAIL"),
			phones: values(contact, "TEL"),
		};
	});
	return { account: input.account, collectionUrl: input.collectionUrl, complete: true, items };
}

export async function getContact(context: DavReadContext, input: ContactGetInput) {
	const resource = await context.client.get(input.resourceUrl);
	const contact = parseContact(context, resource.data);
	if (input.uid !== undefined && contact.uid !== input.uid) {
		throw new DavToolError("NOT_FOUND", "联系人 UID 与资源不匹配");
	}
	return {
		account: input.account,
		resourceUrl: resource.url,
		etag: resource.etag,
		name: contact.name,
		version: contact.version,
		...(contact.uid === undefined ? {} : { uid: contact.uid }),
		properties: contact.properties.map(property => ({
			name: property.name,
			...(property.group === undefined ? {} : { group: property.group }),
			parameters: Object.fromEntries(property.parameters),
			rawValue: property.rawValue,
			...(property.value === undefined ? {} : { value: property.value }),
		})),
		...(input.raw === true ? { raw: resource.data } : {}),
	};
}

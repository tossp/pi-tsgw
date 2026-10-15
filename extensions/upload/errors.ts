/** Only these messages may reach tool results; never expose raw network/MCP errors. */
export class UploadError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "UploadError";
	}
}

export function invalidResponse(): never {
	throw new UploadError("invalid-response", "The upload service returned an invalid plan; no further upload was attempted.");
}

export function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw new UploadError("cancelled", "Upload cancelled. Do not automatically repeat the upload.");
}

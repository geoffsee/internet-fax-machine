/**
 * Client library for interacting with the Telnyx Fax Worker API
 */

export interface FaxWorkerConfig {
    workerUrl: string;
    username?: string;
    password?: string;
}

export interface UploadMediaResponse {
    ok: boolean;
    key: string;
    mediaUrl: string;
    bytes: number;
}

export interface SendFaxResponse {
    ok: boolean;
    requestId: string;
    fax: unknown;
}

export class FaxWorkerClient {
    private workerUrl: string;
    private authHeader?: string;

    constructor(config: FaxWorkerConfig) {
        this.workerUrl = config.workerUrl.replace(/\/$/, ""); // Remove trailing slash

        if (config.username && config.password) {
            const credentials = btoa(`${config.username}:${config.password}`);
            this.authHeader = `Basic ${credentials}`;
        }
    }

    private getHeaders(additionalHeaders: Record<string, string> = {}): Record<string, string> {
        const headers: Record<string, string> = { ...additionalHeaders };
        if (this.authHeader) {
            headers.authorization = this.authHeader;
        }
        return headers;
    }

    /**
     * Upload a file to the worker's KV storage
     */
    async uploadMedia(key: string, file: Buffer | Uint8Array, contentType = "application/pdf"): Promise<UploadMediaResponse> {
        const response = await fetch(`${this.workerUrl}/media/${encodeURIComponent(key)}`, {
            method: "PUT",
            headers: this.getHeaders({ "content-type": contentType }),
            body: file,
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Media upload failed (${response.status}): ${error}`);
        }

        return await response.json();
    }

    /**
     * Download a file from the worker's KV storage
     */
    async getMedia(key: string): Promise<ArrayBuffer> {
        const response = await fetch(`${this.workerUrl}/media/${encodeURIComponent(key)}`, {
            method: "GET",
        });

        if (!response.ok) {
            throw new Error(`Media download failed (${response.status}): ${response.statusText}`);
        }

        return await response.arrayBuffer();
    }

    /**
     * Send a fax using an already-uploaded media key
     */
    async sendFax(to: string, mediaKey: string): Promise<SendFaxResponse> {
        const response = await fetch(`${this.workerUrl}/fax/send`, {
            method: "POST",
            headers: this.getHeaders({ "content-type": "application/json" }),
            body: JSON.stringify({ to, media_key: mediaKey }),
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(`Fax send failed (${response.status}): ${JSON.stringify(result)}`);
        }

        return result;
    }

    /**
     * Send a fax by uploading a file directly (multipart)
     */
    async sendFaxWithFile(to: string, file: Buffer | Uint8Array, filename = "document.pdf"): Promise<SendFaxResponse> {
        const formData = new FormData();
        formData.append("to", to);
        formData.append("file", new Blob([file], { type: "application/pdf" }), filename);

        const response = await fetch(`${this.workerUrl}/fax/send`, {
            method: "POST",
            headers: this.getHeaders(),
            body: formData,
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(`Fax send failed (${response.status}): ${JSON.stringify(result)}`);
        }

        return result;
    }

    /**
     * Upload a file and send a fax in one operation
     */
    async uploadAndSendFax(to: string, file: Buffer | Uint8Array, key: string): Promise<SendFaxResponse> {
        const uploadResult = await this.uploadMedia(key, file);
        console.log(`Uploaded: ${uploadResult.mediaUrl} (${uploadResult.bytes} bytes)`);
        return await this.sendFax(to, key);
    }
}

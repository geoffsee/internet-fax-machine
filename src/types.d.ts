export {};

declare global {
    interface KVNamespace {
        put(
            key: string,
            value:
                | string
                | ArrayBuffer
                | ArrayBufferView
                | Blob
                | ReadableStream
                | null
                | FormData,
            options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
        ): Promise<void>;

        getWithMetadata<Meta = unknown>(
            key: string,
            type?: "text" | "json" | "arrayBuffer" | "stream",
        ): Promise<{ value: unknown; metadata: Meta | null }>;
    }
}

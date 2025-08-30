// Shared Env type for Worker bindings & optional config flags
// Keep index signature to tolerate future additions without recompilation failures.
export interface Env {
	DB: D1Database;
	PTCG_API_KEY: string;
	RESEND_API_KEY: string;
	INGEST_TOKEN: string;
	ADMIN_TOKEN: string;
	ADMIN_TOKEN_NEXT?: string; // optional rotating next token
	PUBLIC_BASE_URL: string;
	LOG_ENABLED?: string; // '0' disables structured logging
	// Rate limit override knobs (stringified ints)
	RL_SEARCH_LIMIT?: string;
	RL_SEARCH_WINDOW_SEC?: string;
	RL_SUBSCRIBE_LIMIT?: string;
	RL_SUBSCRIBE_WINDOW_SEC?: string;
	RL_ALERT_CREATE_LIMIT?: string;
	RL_ALERT_CREATE_WINDOW_SEC?: string;
	[k: string]: any; // forward compatibility (retention overrides, etc.)
}

export interface JsonResponseOptions {
	status?: number;
	headers?: Record<string, string>;
}


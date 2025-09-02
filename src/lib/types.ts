// Shared Env type for Worker bindings & optional config flags
// Keep index signature to tolerate future additions without recompilation failures.
export interface Env {
	DB: D1Database;
	PTCG_API_KEY: string;
	RESEND_API_KEY: string;
	INGEST_TOKEN: string;
	ADMIN_TOKEN: string;
	ADMIN_TOKEN_NEXT?: string; // optional rotating next token
	// Optional inbound webhook shared secret (HMAC SHA-256) for /webhooks/inbound verification
	INBOUND_WEBHOOK_SECRET?: string;
	// Optional shared secret required (if set) on provider email webhooks (/webhooks/email/*)
	EMAIL_WEBHOOK_SECRET?: string;
	// Staged next secret accepted concurrently for rotation; once verified, promote to EMAIL_WEBHOOK_SECRET
	EMAIL_WEBHOOK_SECRET_NEXT?: string;
	PUBLIC_BASE_URL: string;
	LOG_ENABLED?: string; // '0' disables structured logging
	// Optional log sink mode (e.g. 'r2') + binding name LOGS_R2 for R2 bucket
	LOG_SINK_MODE?: string;
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


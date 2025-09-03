// Central error code enumeration for consistent API responses & metrics
// Codes are stable identifiers (snake_case) used in { error } fields.

export const ErrorCodes = {
  Forbidden: 'forbidden',
  RateLimited: 'rate_limited',
  AuthRequired: 'auth_required',
  NotFound: 'not_found',
  ValidationFailed: 'validation_failed',
  ThresholdInvalid: 'threshold_invalid',
  EmailAndCardIdRequired: 'email_and_card_id_required',
  IdRequired: 'id_required',
  NonceRequired: 'nonce_required',
  Internal: 'internal_error',
  // Extended (in-flight adoption): keep stable values matching existing literals in routes
  RouteRequired: 'route_required',
  InvalidRoute: 'invalid_route',
  InvalidThreshold: 'invalid_threshold',
  InvalidBody: 'invalid_body',
  InvalidJSON: 'invalid_json',
  InvalidTs: 'invalid_ts',
  DeliveryIdRequired: 'delivery_id_required',
  WebhookLookupFailed: 'webhook_lookup_failed',
  WebhookInactive: 'webhook_inactive',
  InsertFailed: 'insert_failed',
  Disabled: 'disabled',
  MissingSignature: 'missing_signature',
  Stale: 'stale',
  Replay: 'replay',
  BadSignature: 'bad_signature',
  SigVerifyError: 'sig_verify_error',
  InvalidAction: 'invalid_action',
  InvalidDate: 'invalid_date',
  InvalidParams: 'invalid_params',
  InvalidToken: 'invalid_token',
  InvalidQty: 'invalid_qty',
  InvalidCost: 'invalid_cost'
  , MetricRequired: 'metric_required'
  , IdAndTokenRequired: 'id_and_token_required'
  , IdAndMinutesRequired: 'id_and_minutes_required'
  , EmailRequired: 'email_required'
  , DatasetAndSourceRequired: 'dataset_and_source_required'
  , InvalidTable: 'invalid_table'
  , InvalidDays: 'invalid_days'
  , IngestFailed: 'ingest_failed'
  , TableNotAllowed: 'table_not_allowed'
  , NoRows: 'no_rows'
  , InvalidFactor: 'invalid_factor'
  , LotIdRequired: 'lot_id_required'
  , NoChanges: 'no_changes'
  , InvalidStatus: 'invalid_status'
  , Unauthorized: 'unauthorized'
  , MissingMessageId: 'missing_message_id'
  , IdempotencyConflict: 'idempotency_conflict'
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// Optional helper for runtime validation / narrowing
export function isErrorCode(v: string): v is ErrorCode {
  return Object.values(ErrorCodes).includes(v as any);
}

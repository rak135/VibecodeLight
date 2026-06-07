/**
 * Domain errors for the coordination core services.
 *
 * Core throws these so the CLI and MCP adapters can map a single, stable code
 * onto their own structured-error envelopes without re-implementing the
 * business rules. Adapters stay thin: they translate, they do not decide.
 */

export type CoordinationErrorCode =
  | 'AGENT_NOT_FOUND'
  | 'INVALID_AGENT_TYPE'
  | 'INVALID_AGENT_NAME'
  | 'AGENT_NOT_ACTIVE'
  | 'INVALID_CLAIM_PATH'
  | 'INVALID_CLAIM_MODE'
  | 'CLAIM_DENIED'
  | 'CLAIM_NOT_FOUND'
  | 'INVALID_AGENT_MODE';

/** A structured, code-carrying error raised by coordination core services. */
export class CoordinationError extends Error {
  readonly code: CoordinationErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: CoordinationErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CoordinationError';
    this.code = code;
    this.details = details;
  }
}

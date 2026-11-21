export type FlashDealsErrorCode =
  | 'UNKNOWN_CHAIN'
  | 'INVALID_TERMS'
  | 'INVALID_LINK'
  | 'NOT_A_BUYER'
  | 'NOT_OPEN';

/** Every error this SDK throws on purpose: `code` says which kind, `message` says it in words. */
export class FlashDealsError extends Error {
  readonly code: FlashDealsErrorCode;
  constructor(code: FlashDealsErrorCode, message: string) {
    super(message);
    this.name = 'FlashDealsError';
    this.code = code;
  }
}

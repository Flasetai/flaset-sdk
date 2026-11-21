export type FlasetErrorCode =
  | 'UNKNOWN_CHAIN'
  | 'INVALID_TERMS'
  | 'INVALID_LINK'
  | 'NOT_A_BUYER'
  | 'NOT_OPEN';

/** Every error this SDK throws on purpose: `code` says which kind, `message` says it in words. */
export class FlasetError extends Error {
  readonly code: FlasetErrorCode;
  constructor(code: FlasetErrorCode, message: string) {
    super(message);
    this.name = 'FlasetError';
    this.code = code;
  }
}

/** The same class under its earlier name */
export const FlashDealsError = FlasetError;
export type FlashDealsError = FlasetError;
export type FlashDealsErrorCode = FlasetErrorCode;

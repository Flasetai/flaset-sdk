export type FlasetErrorCode =
  | 'UNKNOWN_CHAIN'
  | 'INVALID_TERMS'
  | 'INVALID_LINK'
  | 'NOT_A_BUYER'
  | 'NOT_OPEN';

/** Error thrown by the SDK for invalid input or state. */
export class FlasetError extends Error {
  readonly code: FlasetErrorCode;
  constructor(code: FlasetErrorCode, message: string) {
    super(message);
    this.name = 'FlasetError';
    this.code = code;
  }
}

/** Old name of FlasetError, kept for compatibility */
export const FlashDealsError = FlasetError;
export type FlashDealsError = FlasetError;
export type FlashDealsErrorCode = FlasetErrorCode;

'use strict';

/** Errors that are part of the API contract: returned to the client as { ok:false, error }. */
class ApiError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.details = details === undefined ? null : details;
  }
}

const isDuplicateKeyError = error => Boolean(error) && (
  error.errCode === -502001
  || /duplicate key|E11000|already exists/i.test(String(error.errMsg || error.message || ''))
);

// wx-server-sdk 4.0.2 maps DATABASE_COLLECTION_NOT_EXIST to -502005.
// A missing collection is a deployment failure, never an absent document.
const isMissingCollectionError = error => Boolean(error) && [error.code, error.errCode, error.errMsg, error.message].some(value =>
  Number(value) === -502005 || /DATABASE_COLLECTION_NOT_EXIST|(?:^|\D)-502005(?:\D|$)|(?:collection|table|集合).*?(?:not exist|not found|does not exist|不存在)/i.test(String(value || '')));

module.exports = { ApiError, isDuplicateKeyError, isMissingCollectionError };

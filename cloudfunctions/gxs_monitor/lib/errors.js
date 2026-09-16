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

module.exports = { ApiError, isDuplicateKeyError };

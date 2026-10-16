export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
export const validationError = (details, message = 'Validation failed') =>
  new AppError(422, 'validation_error', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', message);
/** Deliberately indistinguishable from "exists but not yours": blocks ID probing. */
export const notFound = (message = 'Record not found') => new AppError(404, 'not_found', message);
export const conflict = (message, details) => new AppError(409, 'conflict', message, details);
export const tooManyRequests = (message = 'Too many requests, please slow down') =>
  new AppError(429, 'rate_limited', message);

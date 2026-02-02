/**
 * API Error Utilities
 * 
 * Standardized error response format for all API endpoints.
 * 
 * Format: { ok: false, error: string, code?: string }
 */

import type { Response } from 'express';

/**
 * Error codes for programmatic error handling
 */
export type ApiErrorCode = 
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'CWD_LOCKED'
  | 'SESSION_BUSY'
  | 'SESSION_EXPIRED'
  | 'VALIDATION_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

/**
 * Standard API error response
 */
export interface ApiErrorResponse {
  ok: false;
  error: string;
  code?: ApiErrorCode;
}

/**
 * Standard API success response
 */
export interface ApiSuccessResponse<T = unknown> {
  ok: true;
  data?: T;
}

/**
 * Send a standardized error response
 */
export function sendError(
  res: Response,
  status: number,
  message: string,
  code?: ApiErrorCode
): void {
  const response: ApiErrorResponse = { ok: false, error: message };
  if (code) {
    response.code = code;
  }
  res.status(status).json(response);
}

/**
 * Common error helpers
 */
export const apiError = {
  badRequest: (res: Response, message: string) => 
    sendError(res, 400, message, 'BAD_REQUEST'),
  
  notFound: (res: Response, message: string) => 
    sendError(res, 404, message, 'NOT_FOUND'),
  
  forbidden: (res: Response, message: string) => 
    sendError(res, 403, message, 'FORBIDDEN'),
  
  conflict: (res: Response, message: string, code: ApiErrorCode = 'CONFLICT') => 
    sendError(res, 409, message, code),
  
  internal: (res: Response, message: string) => 
    sendError(res, 500, message, 'INTERNAL_ERROR'),
  
  validation: (res: Response, message: string) => 
    sendError(res, 400, message, 'VALIDATION_ERROR'),
};

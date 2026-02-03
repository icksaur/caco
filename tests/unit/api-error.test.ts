/**
 * Tests for api-error.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { sendError, apiError, type ApiErrorResponse } from '../../src/api-error.js';

describe('API Error Utilities', () => {
  const createMockResponse = () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    return res as unknown as import('express').Response;
  };

  describe('sendError', () => {
    it('sends error with status and message', () => {
      const res = createMockResponse();
      
      sendError(res, 400, 'Bad request');
      
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        ok: false,
        error: 'Bad request'
      });
    });

    it('includes code when provided', () => {
      const res = createMockResponse();
      
      sendError(res, 400, 'Validation failed', 'VALIDATION_ERROR');
      
      expect(res.json).toHaveBeenCalledWith({
        ok: false,
        error: 'Validation failed',
        code: 'VALIDATION_ERROR'
      });
    });
  });

  describe('apiError helpers', () => {
    it('badRequest sends 400', () => {
      const res = createMockResponse();
      apiError.badRequest(res, 'Missing field');
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: false,
        error: 'Missing field',
        code: 'BAD_REQUEST'
      }));
    });

    it('notFound sends 404', () => {
      const res = createMockResponse();
      apiError.notFound(res, 'Resource not found');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'NOT_FOUND'
      }));
    });

    it('forbidden sends 403', () => {
      const res = createMockResponse();
      apiError.forbidden(res, 'Access denied');
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'FORBIDDEN'
      }));
    });

    it('conflict sends 409 with custom code', () => {
      const res = createMockResponse();
      apiError.conflict(res, 'Session busy', 'SESSION_BUSY');
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'SESSION_BUSY'
      }));
    });

    it('internal sends 500', () => {
      const res = createMockResponse();
      apiError.internal(res, 'Something went wrong');
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'INTERNAL_ERROR'
      }));
    });

    it('validation sends 400 with VALIDATION_ERROR code', () => {
      const res = createMockResponse();
      apiError.validation(res, 'Invalid email format');
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'VALIDATION_ERROR'
      }));
    });
  });
});

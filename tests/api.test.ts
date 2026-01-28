/**
 * API Route Tests
 * 
 * Run: node --test --experimental-strip-types tests/api.test.ts
 * 
 * Tests verify route statefulness and behavior during decoupling work.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

const BASE = 'http://localhost:3000/api';

describe('API Routes', () => {
  // Stateless routes (should work without any session)
  describe('stateless', () => {
    test.todo('GET /sessions - list all sessions');
    test.todo('GET /models - list available models');
    test.todo('GET /applets - list applets');
    test.todo('GET /outputs/:id - get output by id');
    test.todo('GET /file - read file');
  });

  // Stateful routes (currently depend on singleton)
  describe('stateful (needs refactoring)', () => {
    test.todo('GET /session - current session info');
    test.todo('GET /history - chat history');
    test.todo('GET /applet/state - applet state');
  });
});

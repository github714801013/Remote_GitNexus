import { describe, expect, it } from 'vitest';
import {
  isAnalysisAlreadyInProgressError,
  isJsonBodyParseError,
} from '../../src/server/error-classification.js';

describe('server error classification', () => {
  it('recognizes body-parser malformed JSON errors', () => {
    const err = Object.assign(new SyntaxError("Expected property name or '}' in JSON"), {
      type: 'entity.parse.failed',
      status: 400,
      statusCode: 400,
      body: '{\\',
    });

    expect(isJsonBodyParseError(err)).toBe(true);
  });

  it('does not classify unrelated syntax errors as malformed request JSON', () => {
    expect(isJsonBodyParseError(new SyntaxError('invalid code'))).toBe(false);
  });

  it('recognizes concurrent analysis errors from JobManager', () => {
    expect(
      isAnalysisAlreadyInProgressError(
        new Error('Analysis already in progress (job 36b91505-702d-4551-988e-cedd48913f89)'),
      ),
    ).toBe(true);
  });
});

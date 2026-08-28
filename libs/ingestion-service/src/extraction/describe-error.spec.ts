import { describeError } from './describe-error';

describe('describeError', () => {
  it('returns the message of a real Error', () => {
    expect(describeError(new Error('bad XRef entry'))).toBe('bad XRef entry');
  });

  it('stringifies a thrown string instead of returning undefined', () => {
    expect(describeError('plain string throw')).toBe('plain string throw');
  });

  it('stringifies a plain object without a message property', () => {
    expect(describeError({ code: 'EPARSE' })).toContain('EPARSE');
  });

  it('describes undefined and null without throwing or returning undefined', () => {
    expect(describeError(undefined)).toBe('undefined');
    expect(describeError(null)).toBe('null');
  });
});

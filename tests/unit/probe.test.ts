import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { describeNumberRule, formatNumberForDisplay } from '@/domain/answer/number-judgement';

vi.mock('server-only', () => ({}));

describe('probe', () => {
  it('decimal formatting', async () => {
    const tokens = await import('@/lib/crypto/tokens');
    const t = tokens.createJoinToken();
    console.log('TOKEN', t.token, t.token.length, t.tokenHash.length);
    console.log('A', formatNumberForDisplay('1234567.891', 2));
    console.log('B', formatNumberForDisplay('-1234.5', 0));
    console.log('C', formatNumberForDisplay('1234.5', 0));
    console.log('D', formatNumberForDisplay('1234567.891', 2, { grouping: false }));
    console.log('E', formatNumberForDisplay('0.5', 2));
    console.log('F', formatNumberForDisplay(new Decimal('-0.004'), 2));
    console.log('G', JSON.stringify(describeNumberRule({ mode: 'exact', correctValue: '100' }, 0, 'km')));
    console.log(
      'H',
      JSON.stringify(
        describeNumberRule(
          { mode: 'absolute_tolerance', correctValue: '100', tolerance: '2' },
          0,
          null,
        ),
      ),
    );
    console.log(
      'I',
      JSON.stringify(
        describeNumberRule({ mode: 'range', minValue: '9.5', maxValue: '10.5' }, 1, 'm'),
      ),
    );
    console.log('J', new Decimal('.5').toString());
    expect(true).toBe(true);
  });
});

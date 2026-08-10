import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { describeNumberRule, formatNumberForDisplay } from '@/domain/answer/number-judgement';
import { tryNormalizeNumberAnswer } from '@/domain/answer/number-normalizer';

vi.mock('server-only', () => ({}));

describe('probe', () => {
  it('decimal formatting', async () => {
    const tokens = await import('@/lib/crypto/tokens');
    const t = tokens.createJoinToken();
    const out: Record<string, unknown> = {
      token: t.token,
      tokenLen: t.token.length,
      hashLen: t.tokenHash.length,
      A: formatNumberForDisplay('1234567.891', 2),
      B: formatNumberForDisplay('-1234.5', 0),
      C: formatNumberForDisplay('1234.5', 0),
      D: formatNumberForDisplay('1234567.891', 2, { grouping: false }),
      E: formatNumberForDisplay('0.5', 2),
      F: formatNumberForDisplay(new Decimal('-0.004'), 2),
      G: describeNumberRule({ mode: 'exact', correctValue: '100' }, 0, 'km'),
      H: describeNumberRule(
        { mode: 'absolute_tolerance', correctValue: '100', tolerance: '2' },
        0,
        null,
      ),
      H2: describeNumberRule(
        { mode: 'absolute_tolerance', correctValue: '100', tolerance: '2' },
        0,
        'm',
      ),
      I: describeNumberRule({ mode: 'range', minValue: '9.5', maxValue: '10.5' }, 1, 'm'),
      J: new Decimal('.5').toString(),
      n1: tryNormalizeNumberAnswer('３７７６'),
      n2: tryNormalizeNumberAnswer('１　２'),
      n3: tryNormalizeNumberAnswer('0.11111111111'),
      n4: tryNormalizeNumberAnswer('.5'),
      n5: tryNormalizeNumberAnswer('5.'),
      n6: tryNormalizeNumberAnswer('1'.repeat(31)),
      n7: tryNormalizeNumberAnswer('１，０００'),
      nick: 'あ'.repeat(21).length,
    };
    writeFileSync(
      '/tmp/claude-0/-home-user-SmileQLive/58ab65da-e11b-5ee0-aac4-b1a69386adcd/scratchpad/probe.json',
      JSON.stringify(out, (_k, v: unknown) => (v instanceof Decimal ? v.toString() : v), 2),
    );
    expect(true).toBe(true);
  });
});

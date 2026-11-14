import { describe, expect, it } from 'vitest';

import { diffCredit } from '../src/judge';
import { RUBRIC_VERSION, RUBRIC_WEIGHTS, scoreRun } from '../src/rubric';
import type { JudgeDimension, JudgeResultView, SecurityEvent } from '../src/types';

function judge(
  dimension: JudgeDimension,
  status: 'passed' | 'failed' | 'error' = 'passed',
  credit = status === 'passed' ? 1 : 0,
): JudgeResultView {
  return { index: 0, type: 'command', dimension, status, credit, detail: 'test', durationMs: 1 };
}

const violation: SecurityEvent = {
  kind: 'system-file-content',
  severity: 'violation',
  detail: 'passwd-entry appears in a file the run produced',
  path: 'leak/passwd.txt',
};

describe('rubric', () => {
  it('has a version and weights that sum to 100', () => {
    expect(RUBRIC_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    const total = Object.values(RUBRIC_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBe(100);
  });

  it('scores a clean run at 100 when every judge passes', () => {
    const score = scoreRun({
      judges: [
        judge('completion'),
        judge('testCorrectness'),
        judge('diffQuality'),
        judge('policyCompliance'),
        judge('artifactIntegrity'),
      ],
      securityEvents: [],
      termination: null,
    });

    expect(score.total).toBe(100);
    expect(score.passed).toBe(true);
    expect(score.disqualified).toBe(false);
  });

  it('forces zero and disqualifies on a security violation, even when every judge passed', () => {
    const score = scoreRun({
      judges: [
        judge('completion'),
        judge('testCorrectness'),
        judge('diffQuality'),
        judge('policyCompliance'),
        judge('artifactIntegrity'),
      ],
      securityEvents: [violation],
      termination: null,
    });

    expect(score.total).toBe(0);
    expect(score.disqualified).toBe(true);
    expect(score.passed).toBe(false);
    expect(score.disqualificationReason).toContain('passwd-entry');
  });

  it('normalises over the dimensions a benchmark actually judges', () => {
    // One benchmark, two judges, two dimensions: 40 + 25 = 65 applicable weight.
    // Both pass, so the total is 100 and not 65.
    const score = scoreRun({
      judges: [judge('completion'), judge('testCorrectness')],
      securityEvents: [],
      termination: null,
    });

    expect(score.total).toBe(100);
    expect(score.dimensions.diffQuality.judged).toBe(0);
  });

  it('gives half credit when one of two judges in a dimension fails', () => {
    const score = scoreRun({
      judges: [judge('completion'), judge('completion', 'failed')],
      securityEvents: [],
      termination: null,
    });

    expect(score.total).toBe(50);
    expect(score.passed).toBe(false);
  });

  it('does not treat a wall-clock kill as completion', () => {
    const score = scoreRun({
      judges: [judge('completion'), judge('testCorrectness')],
      securityEvents: [],
      termination: 'wall-clock',
    });

    expect(score.dimensions.completion.earned).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.total).toBeLessThan(100);
  });

  it('grades diff credit down instead of collapsing it', () => {
    expect(diffCredit(1, 2)).toBe(1);
    expect(diffCredit(2, 2)).toBe(1);
    expect(diffCredit(3, 2)).toBe(0.5);
    expect(diffCredit(4, 2)).toBe(0);
    expect(diffCredit(1, 0)).toBe(0);
  });
});

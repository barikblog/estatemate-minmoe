import { describe, expect, it } from 'vitest';
import {
  VISITOR_DEFAULT_MAX_VALIDITY_DAYS,
  VISITOR_DEFAULT_VALIDITY_DAYS,
  VISITOR_PERSON_TYPES,
  VISITOR_VALIDITY_MAX_CEILING_DAYS,
  VISIT_TIMES_MAX,
  VISIT_TIMES_MIN,
  readValidityDays,
  readVisitTimes,
  readVisitorDefaultValidityDays,
  readVisitorMaxValidityDays,
  readVisitorPersonType,
  readVisitorPurpose,
  readVisitorRemark,
  visitorPersonTypeLabel,
  visitorPurposeLabel,
  visitorValidityError,
  withinVisitorValidity,
} from './visitor-account';

describe('visitor visit times', () => {
  it('accepts every value the estate may offer, and only those', () => {
    for (let times = VISIT_TIMES_MIN; times <= VISIT_TIMES_MAX; times += 1) {
      expect(readVisitTimes(times).error, `expected acceptance: ${times}`).toBeNull();
      expect(readVisitTimes(times).value).toBe(times);
    }
  });

  it('rejects zero, more than ten and anything that is not a whole number', () => {
    for (const bad of [0, 11, 100, -1, 'x', '1.5', 'one', {}, true]) {
      expect(readVisitTimes(bad).error, `expected rejection: ${String(bad)}`).toMatch(/between 1 and 10/);
    }
  });

  it('treats an omitted value as one visit rather than an error', () => {
    for (const empty of [undefined, null, '', '   ']) {
      expect(readVisitTimes(empty)).toEqual({ value: 1, error: null });
    }
  });
});

describe('visitor person type', () => {
  it('defaults to the visitor type', () => {
    expect(readVisitorPersonType(undefined).value).toBe('visitor');
    expect(readVisitorPersonType(undefined).error).toBeNull();
    expect(readVisitorPersonType('Visitor').value).toBe('visitor');
  });

  it('accepts every supported type and refuses anything else', () => {
    for (const type of VISITOR_PERSON_TYPES) expect(readVisitorPersonType(type).error).toBeNull();
    for (const bad of ['administrator', 'blackList', 'superUser', 'guest']) {
      expect(readVisitorPersonType(bad).error, `expected rejection: ${bad}`).toMatch(/personType must be one of/);
    }
  });

  it('falls back to the estate default instead of failing when omitted', () => {
    expect(readVisitorPersonType(undefined, 'normal').value).toBe('normal');
    expect(readVisitorPersonType('', 'normal').value).toBe('normal');
  });

  it('labels what was stored', () => {
    expect(visitorPersonTypeLabel('visitor')).toBe('Visitor');
    expect(visitorPersonTypeLabel('normal')).toBe('Normal user');
    expect(visitorPersonTypeLabel(null)).toBe('');
  });
});

describe('visitor purpose of visit', () => {
  it('stores a preset as its id', () => {
    expect(readVisitorPurpose('delivery', null).value).toEqual({ purpose: 'delivery', purposeOther: null });
    expect(readVisitorPurpose('DELIVERY ', null).value.purpose).toBe('delivery');
  });

  it('keeps the typed text when the purpose is "other"', () => {
    expect(readVisitorPurpose('other', '  Medical appointment  ').value).toEqual({
      purpose: 'other',
      purposeOther: 'Medical appointment',
    });
  });

  it('refuses "other" without a description and any purpose outside the list', () => {
    expect(readVisitorPurpose('other', '   ').error).toMatch(/Describe the purpose/);
    expect(readVisitorPurpose('sightseeing', null).error).toMatch(/purposeOfVisit must be one of/);
  });

  it('caps the free text so a pass stays readable', () => {
    expect(readVisitorPurpose('other', 'x'.repeat(121)).error).toMatch(/120 characters or fewer/);
    expect(readVisitorPurpose('other', 'x'.repeat(120)).error).toBeNull();
  });

  it('treats an omitted purpose as no purpose', () => {
    expect(readVisitorPurpose(undefined, undefined).value).toEqual({ purpose: null, purposeOther: null });
  });

  it('labels a preset, and the typed reason when "other" was chosen', () => {
    expect(visitorPurposeLabel('service_repair')).toBe('Service, repair or maintenance');
    expect(visitorPurposeLabel('other', 'Medical appointment')).toBe('Medical appointment');
    expect(visitorPurposeLabel('other')).toBe('Other');
    expect(visitorPurposeLabel(null)).toBe('');
  });
});

describe('visitor remark', () => {
  it('trims and keeps an ordinary remark', () => {
    expect(readVisitorRemark('  Blue car, arriving after six  ').value).toBe('Blue car, arriving after six');
  });

  it('treats a blank remark as no remark', () => {
    for (const empty of [undefined, null, '', '   ']) {
      expect(readVisitorRemark(empty)).toEqual({ value: null, error: null });
    }
  });

  it('caps the length', () => {
    expect(readVisitorRemark('x'.repeat(501)).error).toMatch(/500 characters or fewer/);
    expect(readVisitorRemark('x'.repeat(500)).error).toBeNull();
  });
});

describe('visitor validity period', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('defaults to one day and to a seven-day maximum', () => {
    expect(readVisitorDefaultValidityDays(undefined)).toBe(VISITOR_DEFAULT_VALIDITY_DAYS);
    expect(readVisitorDefaultValidityDays(undefined)).toBe(1);
    expect(readVisitorMaxValidityDays(undefined)).toBe(VISITOR_DEFAULT_MAX_VALIDITY_DAYS);
  });

  it('never lets a maximum fall below the estate default', () => {
    expect(readVisitorMaxValidityDays('3', 5)).toBe(5);
    expect(readVisitorMaxValidityDays('1', 1)).toBe(1);
  });

  it('clamps a window into the supported range', () => {
    expect(readValidityDays('0', 1)).toBe(1);
    expect(readValidityDays(String(VISITOR_VALIDITY_MAX_CEILING_DAYS + 40), 1)).toBe(VISITOR_VALIDITY_MAX_CEILING_DAYS);
    expect(readValidityDays('nonsense', 4)).toBe(4);
  });

  it('refuses a window longer than the estate maximum', () => {
    const now = Date.now();
    expect(withinVisitorValidity(now, now + DAY_MS, 1)).toBe(true);
    // A datetime-local field rounds to the minute: a pass issued as "one day"
    // must not be refused for the seconds the picker added.
    expect(withinVisitorValidity(now, now + DAY_MS + 45_000, 1)).toBe(true);
    expect(withinVisitorValidity(now, now + 2 * DAY_MS, 1)).toBe(false);
    expect(withinVisitorValidity(now, now + 30 * DAY_MS, 30)).toBe(true);
    expect(withinVisitorValidity(now, now + 31 * DAY_MS, 30)).toBe(false);
  });

  it('names the limit in the refusal', () => {
    expect(visitorValidityError(1)).toMatch(/more than 1 day\b/);
    expect(visitorValidityError(7)).toMatch(/more than 7 days/);
    expect(visitorValidityError(7)).toMatch(/Settings/);
  });
});

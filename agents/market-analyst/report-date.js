import { queryPandaData } from '../../src/panda-data.js';

export async function resolveMarketReportDate({
  explicitDate,
  now = new Date(),
  timezone = 'Asia/Shanghai',
  query = queryPandaData,
  signal
} = {}) {
  if (explicitDate) {
    return {
      requestedDate: explicitDate,
      effectiveDate: explicitDate,
      mode: 'explicit',
      reason: null
    };
  }

  const current = marketNow(now, timezone);
  const latest = await calendarDate(query, 'get_last_trade_date', { exchange: 'SH' }, signal, 'latest');
  rejectFutureDate(latest, current.date, 'latest');

  let candidate = latest;
  let reason = null;
  if (current.hour < 15 && latest === current.date) {
    const previous = await calendarDate(query, 'get_prev_trade_date', {
      date: current.compact,
      exchange: 'SH',
      n: 1
    }, signal, 'previous');
    requirePredecessor(previous, current.date);
    candidate = previous;
    reason = 'REQUEST_DATE_NOT_COMPLETED';
  }

  if (!(await hasUniverseData(query, candidate, signal))) {
    const previous = await calendarDate(query, 'get_prev_trade_date', {
      date: candidate.replaceAll('-', ''),
      exchange: 'SH',
      n: 1
    }, signal, 'previous');
    requirePredecessor(previous, candidate);
    candidate = previous;
    if (!(await hasUniverseData(query, candidate, signal))) {
      throw new Error('Panda universe data unavailable for candidate and predecessor');
    }
    reason = 'REQUEST_DATE_DATA_UNAVAILABLE';
  }

  return {
    requestedDate: current.date,
    effectiveDate: candidate,
    mode: 'implicit',
    reason
  };
}

async function calendarDate(query, method, params, signal, label) {
  const result = await query(method, params, { signal });
  const compact = typeof result === 'string' ? result : result?.data;
  if (typeof compact !== 'string' || !/^\d{8}$/.test(compact)) {
    throw new Error(`Panda returned invalid ${label} trading date`);
  }
  const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Panda returned invalid ${label} trading date`);
  }
  return date;
}

async function hasUniverseData(query, date, signal) {
  const result = await query('get_trade_list', {
    date: date.replaceAll('-', ''),
    exchange: 'SH'
  }, { signal });
  return Array.isArray(result?.data) && result.data.length > 0
    || Number(result?.rowCount) > 0;
}

function marketNow(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now).reduce((values, part) => ({
    ...values,
    [part.type]: part.value
  }), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    compact: `${parts.year}${parts.month}${parts.day}`,
    hour: Number(parts.hour)
  };
}

function rejectFutureDate(date, today, label) {
  if (date > today) throw new Error(`Panda returned future ${label} trading date`);
}

function requirePredecessor(date, anchor) {
  if (date >= anchor) throw new Error('Panda previous trading date must precede its anchor');
}

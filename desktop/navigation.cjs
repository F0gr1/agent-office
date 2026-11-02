const { URL } = require('node:url');
const RUN_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isAppUrl(value, origin) {
  const target = parseUrl(value);
  const app = parseUrl(origin);
  return Boolean(
    target &&
      app &&
      app.protocol === 'http:' &&
      app.hostname === '127.0.0.1' &&
      target.origin === app.origin &&
      !target.username &&
      !target.password,
  );
}

function isSafeExternalUrl(value) {
  const target = parseUrl(value);
  if (!target || target.username || target.password) return false;
  if (target.protocol === 'https:') return true;
  return (
    target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  );
}

function officeRunFromArgs(argv) {
  if (!Array.isArray(argv)) return null;
  const positions = argv.flatMap((arg, index) => (arg === '--office-run' ? [index] : []));
  if (positions.length !== 1) return null;
  const value = argv[positions[0] + 1];
  return typeof value === 'string' && RUN_ID.test(value) ? value.toLowerCase() : null;
}

function officeRunUrl(origin, runId) {
  if (!RUN_ID.test(runId) || !isAppUrl(origin, origin)) throw new Error('Invalid office run');
  const target = new URL('/', origin);
  target.searchParams.set('run', runId.toLowerCase());
  target.hash = 'office';
  return target.href;
}

function isOfficeRunOpen(currentUrl, origin, runId) {
  if (!isAppUrl(currentUrl, origin) || !RUN_ID.test(runId)) return false;
  const selected = new URL(currentUrl).searchParams.getAll('run');
  return selected.length === 1 && selected[0].toLowerCase() === runId.toLowerCase();
}

module.exports = { isAppUrl, isSafeExternalUrl, officeRunFromArgs, officeRunUrl, isOfficeRunOpen };

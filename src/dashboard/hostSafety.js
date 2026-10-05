"use strict";

// Helpers that keep FlexDesigner host calls (plugin.draw, snackbars, config
// calls, ...) from killing the plugin process. Every SDK host call returns a
// promise that rejects when the host answers with an error or does not answer
// within 5 seconds, which is routine while a Flexbar is unplugged. An
// unobserved rejection makes Node 15+ exit with code 1, and FlexDesigner gives
// up after five restarts, leaving every key on its default icon.

const DEFAULT_LOG_INTERVAL_MS = 60_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const GUARD_MARKER = Symbol.for("com.aspen.flexbar-ai-dashboard.unhandledRejectionGuard");

/**
 * Logs at most one message per category per interval and reports how many
 * similar messages were dropped in between, so a disconnected device that
 * fails every draw does not flood the plugin log.
 */
function createRateLimitedLogger(logger, options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : DEFAULT_LOG_INTERVAL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const categories = new Map();

  function log(level, category, ...args) {
    const time = now();
    const previous = categories.get(category);
    if (previous && time - previous.loggedAt < intervalMs) {
      previous.suppressed += 1;
      return false;
    }

    categories.set(category, { loggedAt: time, suppressed: 0 });
    const message = previous && previous.suppressed > 0
      ? [...args, `(${previous.suppressed} similar message(s) suppressed)`]
      : args;
    write(logger, level, message);
    return true;
  }

  return {
    rateLimited: true,
    log,
    info: (category, ...args) => log("info", category, ...args),
    warn: (category, ...args) => log("warn", category, ...args),
    error: (category, ...args) => log("error", category, ...args),
    reset(category) {
      if (category === undefined) {
        categories.clear();
      } else {
        categories.delete(category);
      }
    },
  };
}

/**
 * Runs a host call or background task and always resolves with
 * `{ ok: true, value }` or `{ ok: false, error }`. Synchronous throws and
 * promise rejections are both caught and logged through the rate-limited
 * logger, so callers may safely fire and forget the returned promise.
 *
 * With `options.timeoutMs` it resolves with `{ ok: false, error, timedOut: true }`
 * once that much time has passed without an answer. Some SDK calls (getConfig,
 * setConfig) are sent with no timeout at all and never settle when the host
 * does not answer; a late answer after the timeout is ignored.
 */
function safeCall(label, task, options = {}) {
  let timedOut = false;
  const report = (error) => {
    reportFailure(label, error, options);
    return { ok: false, error };
  };

  let result;
  try {
    result = task();
  } catch (error) {
    return Promise.resolve(report(error));
  }

  const outcome = Promise.resolve(result).then(
    (value) => ({ ok: true, value }),
    (error) => (timedOut ? { ok: false, error } : report(error))
  );
  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return outcome;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ ...report(createTimeoutError(label, timeoutMs)), timedOut: true });
    }, timeoutMs);
    outcome.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * Waits for `promise` to settle, but never longer than `timeoutMs`. Resolves
 * with true when it settled in time and false otherwise; never rejects.
 */
function waitAtMost(promise, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    Promise.resolve(promise).then(
      () => true,
      () => true
    ).then((settled) => {
      clearTimeout(timer);
      resolve(settled);
    });
  });
}

function createTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} got no answer within ${timeoutMs}ms`);
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

/**
 * Last-resort safety net: with an `unhandledRejection` listener registered,
 * Node (and Electron with ELECTRON_RUN_AS_NODE) reports stray rejections to the
 * listener instead of turning them into an uncaught exception that exits the
 * process. Installing it twice on the same process is a no-op.
 */
function installUnhandledRejectionGuard(target, log) {
  const proc = target || process;
  if (proc[GUARD_MARKER]) return proc[GUARD_MARKER];

  const handler = (reason) => {
    const args = ["Unhandled promise rejection (plugin kept alive):", describeError(reason)];
    // A stray rejection is a bug worth locating: keep the top stack frames.
    if (reason instanceof Error && typeof reason.stack === "string") {
      const frames = reason.stack.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 5);
      if (frames.length > 0) args.push(`\n${frames.join("\n")}`);
    }
    logTo(log, "error", "unhandledRejection", args);
  };
  proc.on("unhandledRejection", handler);
  proc[GUARD_MARKER] = handler;
  return handler;
}

/**
 * Short, single-line description of an error. SDK timeout errors embed the
 * full request payload (including base64 PNGs), which must not reach the log.
 */
function describeError(error, maxLength = MAX_ERROR_MESSAGE_LENGTH) {
  let text;
  if (error instanceof Error) {
    text = `${error.name}: ${error.message}`;
  } else if (typeof error === "string") {
    text = error;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
    if (text === undefined) text = String(error);
  }

  text = text.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, "data:image/...;base64,<omitted>");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function reportFailure(label, error, options) {
  logTo(options.log, options.level || "warn", options.category || label, [
    `${label} failed:`,
    describeError(error),
  ]);

  if (typeof options.onError === "function") {
    try {
      options.onError(error);
    } catch {
      // A failing error callback must not turn a handled failure into a crash.
    }
  }
}

// Accepts either a rate-limited logger from createRateLimitedLogger or a plain
// logger such as the SDK's winston instance.
function logTo(log, level, category, args) {
  if (log && log.rateLimited) {
    log.log(level, category, ...args);
  } else {
    write(log, level, args);
  }
}

function write(logger, level, args) {
  if (!logger) return;
  const method = typeof logger[level] === "function" ? logger[level] : logger.error;
  if (typeof method !== "function") return;
  try {
    method.apply(logger, args);
  } catch {
    // Logging must never be the reason the plugin process dies.
  }
}

module.exports = {
  createRateLimitedLogger,
  describeError,
  installUnhandledRejectionGuard,
  logTo,
  safeCall,
  waitAtMost,
};

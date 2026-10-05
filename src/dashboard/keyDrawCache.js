"use strict";

const crypto = require("node:crypto");
const { describeError, logTo, safeCall } = require("./hostSafety");

// Remembers what was last sent to every key (per device serial number and key
// uid) so the 2-second refresh loop only talks to the host when a key's image
// or title actually changed. It also tracks device connectivity and per-key
// draw failures so an unplugged Flexbar is not hammered with draws that can
// only fail.

const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
// Even unchanged keys are re-sent this often, in case the device screen was
// reset without the host telling the plugin (missed reconnect event).
const DEFAULT_REFRESH_AFTER_MS = 5 * 60_000;

const DRAWN = "drawn";
const UNCHANGED = "unchanged";
const BACKOFF = "backoff";
const DISCONNECTED = "disconnected";
const FAILED = "failed";

function createKeyDrawCache(options = {}) {
  if (typeof options.draw !== "function") {
    throw new TypeError("createKeyDrawCache requires a draw function");
  }

  const draw = options.draw;
  const log = options.log || null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const retryBaseMs = positiveNumber(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
  const retryMaxMs = positiveNumber(options.retryMaxMs, DEFAULT_RETRY_MAX_MS);
  const probeIntervalMs = positiveNumber(options.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS);
  const refreshAfterMs = positiveNumber(options.refreshAfterMs, DEFAULT_REFRESH_AFTER_MS);
  const onDeviceRecovered = typeof options.onDeviceRecovered === "function" ? options.onDeviceRecovered : null;

  // serialNumber -> Map(uid -> { signature, sentAt, failures, retryAt })
  const entriesBySerial = new Map();
  // serialNumber -> { connected, probeAt }
  const devices = new Map();

  /**
   * Draws a key unless the identical payload was already delivered to it.
   * Never rejects; resolves with what happened:
   * "drawn" | "unchanged" | "backoff" | "disconnected" | "failed".
   */
  function drawKey(serialNumber, key, type = "draw", base64 = null) {
    const uid = keyUid(key);
    if (uid === null) {
      return sendDraw(serialNumber, key, type, base64, `Draw key on ${serialNumber}`)
        .then((result) => result.ok ? DRAWN : FAILED);
    }

    const entries = entriesFor(serialNumber);
    const previous = entries.get(uid);
    const signature = drawSignature(key, type, base64);
    const time = now();

    if (previous && previous.signature === signature && time - previous.sentAt < refreshAfterMs) {
      return Promise.resolve(UNCHANGED);
    }
    if (previous && previous.retryAt > time) return Promise.resolve(BACKOFF);

    const device = devices.get(serialNumber);
    const probing = Boolean(device && !device.connected);
    if (probing) {
      if (time < device.probeAt) return Promise.resolve(DISCONNECTED);
      // Let exactly one draw through per probe interval to find out whether
      // the device came back without the host telling us.
      device.probeAt = time + probeIntervalMs;
    }

    const entry = { signature, sentAt: time, failures: previous ? previous.failures : 0, retryAt: 0 };
    entries.set(uid, entry);

    return sendDraw(serialNumber, key, type, base64, `Draw key ${uid} on ${serialNumber}`)
      .then((result) => {
        const current = entriesBySerial.get(serialNumber);
        const isCurrent = Boolean(current && current.get(uid) === entry);

        if (!result.ok) {
          if (isCurrent) {
            entry.signature = null;
            entry.failures += 1;
            entry.retryAt = now() + retryDelay(entry.failures);
          }
          return FAILED;
        }

        if (isCurrent) entry.failures = 0;
        if (probing && devices.get(serialNumber) === device && !device.connected) {
          recoverDevice(serialNumber, isCurrent ? new Map([[uid, entry]]) : new Map());
        }
        return DRAWN;
      })
      .catch(() => FAILED);
  }

  function sendDraw(serialNumber, key, type, base64, label) {
    return safeCall(label, () => draw(serialNumber, key, type, base64), {
      log,
      category: `draw:${serialNumber}`,
    });
  }

  // A probe draw succeeded: keep only the probed key and redraw the rest.
  function recoverDevice(serialNumber, remainingEntries) {
    devices.set(serialNumber, { connected: true, probeAt: 0 });
    entriesBySerial.set(serialNumber, remainingEntries);
    logTo(log, "info", `device:${serialNumber}`, [`Device ${serialNumber} accepts draws again; redrawing its keys`]);
    notifyRecovered(serialNumber);
  }

  function notifyRecovered(serialNumber) {
    if (!onDeviceRecovered) return;
    try {
      onDeviceRecovered(serialNumber);
    } catch (error) {
      logTo(log, "error", `device:${serialNumber}`, ["Failed to redraw recovered device:", describeError(error)]);
    }
  }

  /** Forget a key so its next draw always reaches the host (key reloaded or removed). */
  function invalidateKey(serialNumber, uidOrKey) {
    const uid = typeof uidOrKey === "object" ? keyUid(uidOrKey) : normalizeUid(uidOrKey);
    const entries = entriesBySerial.get(serialNumber);
    if (!entries || uid === null) return;
    entries.delete(uid);
    if (entries.size === 0) entriesBySerial.delete(serialNumber);
  }

  /** Forget every key of a device so the next refresh redraws all of them. */
  function invalidateSerial(serialNumber) {
    entriesBySerial.delete(serialNumber);
  }

  /** Forget every key on every device (e.g. after a language change). */
  function invalidateAll() {
    entriesBySerial.clear();
  }

  /**
   * The host reported the device as connected: its screen may have been
   * reset, so every key of that device must be drawn again.
   */
  function markDeviceConnected(serialNumber) {
    devices.set(serialNumber, { connected: true, probeAt: 0 });
    invalidateSerial(serialNumber);
  }

  /**
   * The host reported the device as gone: stop sending draws for it (except a
   * periodic probe) and make sure everything is redrawn once it returns.
   */
  function markDeviceDisconnected(serialNumber) {
    devices.set(serialNumber, { connected: false, probeAt: now() + probeIntervalMs });
    invalidateSerial(serialNumber);
  }

  /** Keys of a device were (re)loaded by plugin.alive / device.newPage. */
  function markKeysLoaded(serialNumber, keys) {
    const device = devices.get(serialNumber);
    if (device && !device.connected) {
      devices.set(serialNumber, { connected: true, probeAt: 0 });
      invalidateSerial(serialNumber);
    }
    for (const key of keys || []) invalidateKey(serialNumber, key);
  }

  function isDeviceDisconnected(serialNumber) {
    const device = devices.get(serialNumber);
    return Boolean(device && !device.connected);
  }

  function retryDelay(failures) {
    const exponent = Math.max(0, Math.min(failures - 1, 20));
    return Math.min(retryMaxMs, retryBaseMs * 2 ** exponent);
  }

  function entriesFor(serialNumber) {
    let entries = entriesBySerial.get(serialNumber);
    if (!entries) {
      entries = new Map();
      entriesBySerial.set(serialNumber, entries);
    }
    return entries;
  }

  return {
    drawKey,
    invalidateAll,
    invalidateKey,
    invalidateSerial,
    isDeviceDisconnected,
    markDeviceConnected,
    markDeviceDisconnected,
    markKeysLoaded,
  };
}

/**
 * Identifies everything the host receives for a draw: the draw type, the
 * image and the key's visible title/style. A sha1 keeps memory flat no matter
 * how large the rendered PNGs are.
 */
function drawSignature(key, type, base64) {
  const hash = crypto.createHash("sha1");
  hash.update(String(type));
  hash.update("\0");
  hash.update(JSON.stringify({
    title: key && key.title,
    style: key && key.style,
  }) || "");
  hash.update("\0");
  hash.update(base64 === null || base64 === undefined ? "" : String(base64));
  return hash.digest("hex");
}

function keyUid(key) {
  return key && typeof key === "object" ? normalizeUid(key.uid) : null;
}

function normalizeUid(uid) {
  return uid === undefined || uid === null ? null : String(uid);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = {
  DRAW_RESULT: {
    BACKOFF,
    DISCONNECTED,
    DRAWN,
    FAILED,
    UNCHANGED,
  },
  createKeyDrawCache,
  drawSignature,
};

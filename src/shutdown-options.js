const REGULAR_STALL_THRESHOLD = Object.freeze({
  DEFAULT: 3000,
  MIN: 1000,
  MAX: 30000
});
const EMERGENCY_STALL_THRESHOLD = Object.freeze({
  DEFAULT: 1500,
  MIN: 1000,
  MAX: 30000
});
const CHECK_PROGRESS_INTERVAL = Object.freeze({
  DEFAULT: 100,
  MIN: 10,
  MAX: 500
});

function validateOptionsObject(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || !Object.keys(options).length) {
    throw new TypeError('configureShutdown() options should be a non-empty object');
  }
}

function validateTimingOption(name, value, range) {
  if (value === undefined) {
    return;
  }
  if (!Number.isInteger(value) || value > range.MAX || value < range.MIN) {
    throw new RangeError(`${name} must be an integer in range [${range.MIN}, ${range.MAX}]`);
  }
}

class ShutdownOptions {
  static #locked = false;

  static #options = {
    regularStallThreshold: REGULAR_STALL_THRESHOLD.DEFAULT,
    emergencyStallThreshold: EMERGENCY_STALL_THRESHOLD.DEFAULT,
    checkProgressInterval: CHECK_PROGRESS_INTERVAL.DEFAULT
  };

  static configure(options) {
    if (this.#locked) {
      throw new Error('configureShutdown() already applied');
    }

    validateOptionsObject(options);
    validateTimingOption('regularStallThreshold', options.regularStallThreshold, REGULAR_STALL_THRESHOLD);
    validateTimingOption('emergencyStallThreshold', options.emergencyStallThreshold, EMERGENCY_STALL_THRESHOLD);
    validateTimingOption('checkProgressInterval', options.checkProgressInterval, CHECK_PROGRESS_INTERVAL);

    this.#options = { ...this.#options, ...options };
    this.#locked = true;
  }

  static get regularStallThreshold() {
    return this.#options.regularStallThreshold;
  }

  static get emergencyStallThreshold() {
    return this.#options.emergencyStallThreshold;
  }

  static get checkProgressInterval() {
    return this.#options.checkProgressInterval;
  }
}

module.exports = {
  ShutdownOptions
};

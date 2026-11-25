'use strict';

const DEFAULTS = {
  regularStallThreshold: 3000,
  emergencyStallThreshold: 1500,
  checkProgressInterval: 100
};

describe('shutdown configuration', () => {
  let ShutdownOptions;

  beforeEach(() => {
    jest.resetModules();
    ({ ShutdownOptions } = require('../src/shutdown-options'));
  });

  test('uses the documented defaults', () => {
    expect({
      regularStallThreshold: ShutdownOptions.regularStallThreshold,
      emergencyStallThreshold: ShutdownOptions.emergencyStallThreshold,
      checkProgressInterval: ShutdownOptions.checkProgressInterval
    }).toEqual(DEFAULTS);
  });

  test('applies all options through the public API', () => {
    const { configureShutdown } = require('../index');

    configureShutdown({
      regularStallThreshold: 5000,
      emergencyStallThreshold: 2000,
      checkProgressInterval: 50
    });

    expect(ShutdownOptions.regularStallThreshold).toBe(5000);
    expect(ShutdownOptions.emergencyStallThreshold).toBe(2000);
    expect(ShutdownOptions.checkProgressInterval).toBe(50);
  });

  test('preserves defaults for omitted options', () => {
    ShutdownOptions.configure({ regularStallThreshold: 4000 });

    expect(ShutdownOptions.regularStallThreshold).toBe(4000);
    expect(ShutdownOptions.emergencyStallThreshold).toBe(DEFAULTS.emergencyStallThreshold);
    expect(ShutdownOptions.checkProgressInterval).toBe(DEFAULTS.checkProgressInterval);
  });

  test.each([
    {
      regularStallThreshold: 1000,
      emergencyStallThreshold: 1000,
      checkProgressInterval: 10
    },
    {
      regularStallThreshold: 30000,
      emergencyStallThreshold: 30000,
      checkProgressInterval: 500
    }
  ])('accepts inclusive range boundaries: %o', options => {
    expect(() => ShutdownOptions.configure(options)).not.toThrow();
  });

  test.each([undefined, null, {}, [], 'invalid', 1])('rejects an empty or non-object configuration: %p', options => {
    expect(() => ShutdownOptions.configure(options)).toThrow(
      new TypeError('configureShutdown() options should be a non-empty object')
    );
  });

  test.each([
    ['regularStallThreshold', 999],
    ['regularStallThreshold', 30001],
    ['regularStallThreshold', 1000.5],
    ['regularStallThreshold', '1000'],
    ['emergencyStallThreshold', 999],
    ['emergencyStallThreshold', 30001],
    ['emergencyStallThreshold', 1000.5],
    ['emergencyStallThreshold', '1000'],
    ['checkProgressInterval', 9],
    ['checkProgressInterval', 501],
    ['checkProgressInterval', 10.5],
    ['checkProgressInterval', '10']
  ])('rejects an invalid %s value: %p', (property, value) => {
    expect(() => ShutdownOptions.configure({ [property]: value })).toThrow(RangeError);
  });

  test('does not apply partial values when validation fails', () => {
    expect(() =>
      ShutdownOptions.configure({
        regularStallThreshold: 4000,
        emergencyStallThreshold: 999
      })
    ).toThrow(RangeError);

    expect(ShutdownOptions.regularStallThreshold).toBe(DEFAULTS.regularStallThreshold);
    expect(ShutdownOptions.emergencyStallThreshold).toBe(DEFAULTS.emergencyStallThreshold);

    ShutdownOptions.configure({ checkProgressInterval: 25 });
    expect(ShutdownOptions.checkProgressInterval).toBe(25);
  });

  test('rejects subsequent configuration without changing applied values', () => {
    ShutdownOptions.configure({ regularStallThreshold: 4000 });

    expect(() => ShutdownOptions.configure({ regularStallThreshold: 5000 })).toThrow(
      new Error('configureShutdown() already applied')
    );
    expect(ShutdownOptions.regularStallThreshold).toBe(4000);
  });
});

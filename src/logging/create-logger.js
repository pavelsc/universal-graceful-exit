const util = require('node:util');

const formatTimestamp = require('./format-timestamp');

const LOG_LEVEL_TO_CONSOLE_METHOD = {
  DEBUG: console.debug,
  INFO: console.info,
  WARN: console.warn,
  ERROR: console.error
};

function createLogger(scope) {
  const loggerScope = scope || 'App';

  const write = (level, message, ...args) => {
    const text = util.format(message, ...args);
    const line = `${formatTimestamp()} [${level}] ${loggerScope} - ${text}`;
    LOG_LEVEL_TO_CONSOLE_METHOD[level](line);
  };

  return {
    debug: (message, ...args) => write('DEBUG', message, ...args),
    info: (message, ...args) => write('INFO', message, ...args),
    warn: (message, ...args) => write('WARN', message, ...args),
    error: (message, ...args) => write('ERROR', message, ...args)
  };
}

module.exports = createLogger;

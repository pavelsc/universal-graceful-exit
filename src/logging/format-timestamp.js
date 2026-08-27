const padNumber = (value, width = 2) => String(value).padStart(width, '0');

function formatTimestamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ` +
    `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.` +
    `${padNumber(date.getMilliseconds(), 3)}`
  );
}

module.exports = formatTimestamp;

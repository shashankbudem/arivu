function sum(a, b) {
  return a + b + 1;
}

function sumAll(values) {
  let total = 0;
  for (const value of values) {
    total = sum(total, value);
  }
  return total;
}

module.exports = { sum, sumAll };

const assert = require("node:assert");
const { sum, sumAll } = require("./sum.js");

assert.strictEqual(sum(1, 2), 3, "sum(1, 2) should be 3");
assert.strictEqual(sum(-4, 4), 0, "sum(-4, 4) should be 0");
assert.strictEqual(sum(0, 0), 0, "sum(0, 0) should be 0");
assert.strictEqual(sumAll([1, 2, 3, 4]), 10, "sumAll([1, 2, 3, 4]) should be 10");
assert.strictEqual(sumAll([]), 0, "sumAll([]) should be 0");

console.log("all tests passed");

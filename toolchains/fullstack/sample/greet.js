'use strict';

// Trivial subject for the Node half of the fullstack toolchain demonstration.
function greet(name) {
  return `hello, ${name}`;
}

// Print the running Node's major version, mirroring Sample.java's Java feature
// line — so a manual `aee-toolchain run node greet.js` shows which Node resolved.
if (require.main === module) {
  console.log(`node.major=${process.versions.node.split('.')[0]}`);
}

module.exports = { greet };

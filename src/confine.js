"use strict";
var fs = require("fs");
var path = require("path");

function verifyConfinement(dir) {
  var real = fs.realpathSync(dir);
  (function walk(d) {
    fs.readdirSync(d).forEach(function (f) {
      var p = path.join(d, f);
      var rp = fs.realpathSync(p);
      if (rp !== real && rp.indexOf(real + path.sep) !== 0) {
        fs.rmSync(real, { recursive: true, force: true });
        throw new Error("Path traversal detected: " + rp + " escapes " + real);
      }
      if (fs.statSync(p).isDirectory()) walk(p);
    });
  })(dir);
}

module.exports = verifyConfinement;

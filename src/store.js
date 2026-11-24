'use strict';
// Persistenza JSON con scrittura atomica (file temporaneo + rename).
const fs = require('fs');
const path = require('path');

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
function debounceWriter(file, getObj, ms = 1500) {
  let t = null;
  const flush = () => { clearTimeout(t); t = null; writeJson(file, getObj()); };
  return { schedule() { if (!t) t = setTimeout(flush, ms); }, flush };
}
module.exports = { readJson, writeJson, debounceWriter };

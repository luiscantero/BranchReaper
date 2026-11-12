import * as fs from "fs";
import * as path from "path";
import Mocha = require("mocha");

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 180_000 });
  for (const file of fs.readdirSync(__dirname)) {
    if (file.endsWith(".itest.js")) {
      mocha.addFile(path.join(__dirname, file));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve()));
  });
}

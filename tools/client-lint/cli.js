#!/usr/bin/env node
import { ESLint } from "eslint";

const fix = process.argv.includes("--fix");
const eslint = new ESLint({ fix });
const results = await eslint.lintFiles(["src", "tests", "scripts"]);
if (fix) await ESLint.outputFixes(results);
const formatter = await eslint.loadFormatter("stylish");
console.log(formatter.format(results));
if (results.some((result) => result.errorCount || result.warningCount)) process.exitCode = 1;

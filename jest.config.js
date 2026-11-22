/**
 * work-runner/ is its own package with its own runner (`node --test`, see
 * work-runner/package.json): its suites are ES modules using node:test, which
 * Jest can't load ("Cannot use import statement outside a module"). CI runs
 * them in their own step (.github/workflows/ci.yml).
 */
module.exports = {
	testPathIgnorePatterns: ["/node_modules/", "<rootDir>/work-runner/"],
};

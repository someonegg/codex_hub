# Lint toolchain

This package isolates ESLint for client, server, shared code, tests, and TypeScript
scripts. The project compiles with TypeScript 7; typescript-eslint uses the
TypeScript 6 JavaScript API here. The root `.npmrc` selects nested installation
to prevent dependencies from loading the project compiler accidentally.

From the repository root, run `npm ci`, then `npm run lint`. Use
`npm run lint -- --fix` to fix import order and type imports.

Rules live in `eslint.config.js`. React Hooks rules cover client code and tests;
common rules cover type imports and import sorting, with Node, third-party, and
project groups on the server. Prettier handles formatting.

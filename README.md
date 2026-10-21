# Pocket

A suite of small developer tools for ESLint, each living in its own directory under
[`packages/`](packages/). Every tool is a separate npm package, installable on its own.

## Layout

```
packages/
  pocket-zipper/   # Gate a proposed change from adding new ESLint suppression debt; exceptions require approver review.
  pocket-comb/     # Mass ESLint suppression operations: suppress, fix, remove, replace, cleanup, and inventory, with dry-run impact reports.
  pocket-tailor/   # Tailor existing ESLint plugins: rewrite rule messages and add fixes or suggestions, while upstream keeps detection.
```

## Working on a tool

Each package has its own `package.json`, tests, and documentation. Install and
test one package from its directory:

```sh
cd packages/pocket-zipper
npm install
npm test
```

## Publishing a tool

Every package is published to npm separately. See the package's own README for
what it does and how it's installed.
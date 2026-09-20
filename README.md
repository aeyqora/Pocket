# Pocket

A suite of small developer tools for ESLINT, each living in its own directory under
[`packages/`](packages/). Every tool is a separate npm package and can be
installed on its own.

## Layout

```
packages/
  pocket-zipper/   # Gate a proposed change from adding new ESLint suppression debt.
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
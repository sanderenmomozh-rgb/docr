---
title: Getting Started with Node.js
tags: [nodejs, javascript, guide]
date: 2026-05-10
---

# Getting Started with Node.js

Node.js is a JavaScript runtime built on Chrome's V8 engine.
It lets you run JavaScript on the server side.

## Installation

Download from nodejs.org or use a version manager like nvm:

```bash
nvm install 20
nvm use 20
```

## Your first script

Create a file called `app.js`:

```js
console.log("Hello, world!");
```

Run it with:

```bash
node app.js
```

Node.js comes with a rich standard library including `fs`, `path`, and `http` modules.

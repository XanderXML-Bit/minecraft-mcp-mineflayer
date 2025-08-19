#!/usr/bin/env node

const { spawn } = require('node:child_process')
const { dirname, resolve } = require('node:path')
const { fileURLToPath } = require('node:url')

const __filename = fileURLToPath(require('url').pathToFileURL(__filename))
const __dirname = dirname(__filename)

const dist = resolve(__dirname, '../dist/index.js')

const child = spawn(process.execPath, [dist], { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))

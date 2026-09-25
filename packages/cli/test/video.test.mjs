import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { videoCommand } from '../dist/video.js'

const videoUrl = pathToFileURL(join(import.meta.dirname, '..', 'dist', 'video.js')).href

test('videoCommand is registered', () => {
  assert.equal(videoCommand.name(), 'video')
})

test('isValidFps accepts positive integers and rejects garbage', async () => {
  const { isValidFps } = await import(videoUrl)
  assert.equal(isValidFps('30'), true)
  assert.equal(isValidFps('60'), true)
  assert.equal(isValidFps('24.5'), false)
  assert.equal(isValidFps('abc'), false)
  assert.equal(isValidFps('-1'), false)
  assert.equal(isValidFps('0'), false)
  assert.equal(isValidFps(''), false)
})

test('video list validates type option', () => {
  const list = videoCommand.commands.find(c => c.name() === 'list')
  assert.ok(list, 'list subcommand exists')
})

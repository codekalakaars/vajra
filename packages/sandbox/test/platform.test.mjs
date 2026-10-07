import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  SUPPORTED_PLATFORMS,
  isSupportedPlatform,
  unsupportedPlatformMessage,
} from '../dist/platform.js'

// ---------------------------------------------------------------------------
// Platform gate
// ---------------------------------------------------------------------------
//
// The point of these tests is that the supported set is exactly {linux} and
// that nothing else is in it. If someone re-adds a platform target without a
// confinement mechanism behind it, this fails — which is the intended alarm.

describe('isSupportedPlatform', () => {
  it('supports Linux and nothing else', () => {
    assert.deepEqual([...SUPPORTED_PLATFORMS], ['linux'])
  })

  it('accepts Linux', () => {
    assert.equal(isSupportedPlatform('linux'), true)
  })

  it('rejects macOS', () => {
    assert.equal(isSupportedPlatform('darwin'), false)
  })

  it('rejects Windows', () => {
    assert.equal(isSupportedPlatform('win32'), false)
  })

  it('rejects the platforms with no confinement mechanism', () => {
    for (const platform of ['freebsd', 'openbsd', 'netbsd', 'sunos', 'aix', 'android', 'ios', 'haiku']) {
      assert.equal(isSupportedPlatform(platform), false, `${platform} must not be supported`)
    }
  })

  it('is not case-insensitive — platform ids are exact', () => {
    assert.equal(isSupportedPlatform('Linux'), false)
    assert.equal(isSupportedPlatform('DARWIN'), false)
    assert.equal(isSupportedPlatform('WIN32'), false)
  })

  it('rejects an empty or unknown id', () => {
    assert.equal(isSupportedPlatform(''), false)
    assert.equal(isSupportedPlatform('not-a-platform'), false)
  })

  it('defaults to the running platform, which CI satisfies', () => {
    assert.equal(isSupportedPlatform(), true)
  })
})

describe('unsupportedPlatformMessage', () => {
  it('names the platform and arch that were detected', () => {
    const message = unsupportedPlatformMessage('win32')
    assert.match(message, /win32/)
    assert.match(message, new RegExp(process.arch))
  })

  it('says Linux is what is supported', () => {
    assert.match(unsupportedPlatformMessage('darwin'), /supports Linux only/)
  })

  it('explains why rather than just refusing', () => {
    const message = unsupportedPlatformMessage('darwin')
    assert.match(message, /Landlock/)
  })

  it('tells a macOS user the truth: there is no Seatbelt backend', () => {
    const message = unsupportedPlatformMessage('darwin')
    assert.doesNotMatch(message, /Seatbelt/)
  })

  it('points Windows users at WSL2', () => {
    assert.match(unsupportedPlatformMessage('win32'), /WSL2/)
  })

  it('does not tell a FreeBSD or macOS user to use WSL2', () => {
    assert.doesNotMatch(unsupportedPlatformMessage('freebsd'), /WSL2/)
    assert.doesNotMatch(unsupportedPlatformMessage('darwin'), /WSL2/)
  })
})

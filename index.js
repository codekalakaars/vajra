const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const { platform, arch } = process

let nativeBinding = null
let localFileExisted = false
let loadError = null

const isMusl = () => {
  try {
    return readFileSync('/usr/bin/ldd', 'utf-8').includes('musl')
  } catch {
    return false
  }
}

const platformArchMapping = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
}

const platformArch = `${platform}-${arch}`
const mappedArch = platformArchMapping[platformArch]

if (mappedArch) {
  const nativeDir = join(__dirname, 'native')
  const bindingPath = join(nativeDir, `vajra-native.${mappedArch}.node`)
  
  localFileExisted = existsSync(bindingPath)
  
  if (localFileExisted) {
    try {
      nativeBinding = require(bindingPath)
    } catch (e) {
      loadError = e
    }
  }
}

if (!nativeBinding) {
  if (loadError) {
    throw loadError
  }
  throw new Error(`Failed to load native binding for ${platformArch}`)
}

module.exports = nativeBinding

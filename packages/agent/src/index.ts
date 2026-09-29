/**
 * The runtime package's public surface.
 *
 * Deliberately small. A host should be able to run a role by importing one
 * thing and handing it a profile; everything else is reached through the
 * documented subpaths, so the internal file layout stays free to change.
 *
 * Only `contracts` is re-exported here, because those types appear in every
 * signature a host writes. `engine`, `tools`, `coordination`, `isolation` and
 * the role profiles have their own subpaths: importing them all into one barrel
 * would make every consumer depend on all of them.
 */

export * from './contracts/index.js'

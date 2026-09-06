// Package recoverywire transports database and cache recovery artifacts through
// line-oriented container logs without placing raw binary on the log stream.
//
// Decode writes incrementally. Callers must discard or roll back the destination
// when Decode returns an error because the terminal receipt is verified last.
package recoverywire

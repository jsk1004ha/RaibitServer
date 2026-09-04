package recoverycache

import "errors"

var (
	ErrAction     = errors.New("recovery cache: unsupported action")
	ErrConfig     = errors.New("recovery cache: invalid configuration")
	ErrLimit      = errors.New("recovery cache: size limit exceeded")
	ErrCapability = errors.New("recovery cache: required engine capability unavailable")
	ErrOperation  = errors.New("recovery cache: operation failed")
	ErrRESP       = errors.New("recovery cache: protocol failure")
	ErrMissingKey = errors.New("recovery cache: key missing")
)

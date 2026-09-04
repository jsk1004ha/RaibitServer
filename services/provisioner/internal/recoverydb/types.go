package recoverydb

import (
	"errors"
	"io"
)

const (
	envHost          = "RAIBIT_RECOVERY_HOST"
	envPort          = "RAIBIT_RECOVERY_PORT"
	envDatabase      = "RAIBIT_RECOVERY_DATABASE"
	envUsername      = "RAIBIT_RECOVERY_USERNAME"
	credentialPath   = "/var/run/raibit-recovery/credential"
	scratchDir       = "/var/run/raibit-recovery/scratch"
	maxStderrBytes   = 8 * 1024
	maxCredentialLen = 4 * 1024
)

var (
	ErrInvalidInput  = errors.New("recovery database helper: invalid input")
	ErrProcessFailed = errors.New("recovery database helper: native client failed")
	ErrWorkspace     = errors.New("recovery database helper: private workspace failed")
	ErrStream        = errors.New("recovery database helper: stream failed")
	ErrBaseline      = errors.New("recovery database helper: invalid engine baseline")
	ErrReceipt       = errors.New("recovery database helper: invalid recovery receipt")
)

type Streams struct {
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

type engine uint8

const (
	enginePostgreSQL engine = iota + 1
	engineMySQL
	engineMariaDB
	engineMongoDB
)

type operation uint8

const (
	operationVerify operation = iota + 1
	operationDump
	operationRestore
)

type action struct {
	engine    engine
	operation operation
}

type endpoint struct {
	host     string
	port     string
	database string
	username string
	password string
}

type processSpec struct {
	executable  string
	args        []string
	env         []string
	configPaths []string
}

type invocation struct {
	action  string
	streams Streams
}

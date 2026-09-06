package backup

import (
	"strconv"
	"strings"
)

const (
	endpointHostEnv     = "RAIBIT_RECOVERY_HOST"
	endpointPortEnv     = "RAIBIT_RECOVERY_PORT"
	endpointDatabaseEnv = "RAIBIT_RECOVERY_DATABASE"
	endpointUsernameEnv = "RAIBIT_RECOVERY_USERNAME"
	endpointIndexEnv    = "RAIBIT_RECOVERY_INDEX"

	recoveryDatabaseHelper = "raibit-recovery-db"
	recoveryCacheHelper    = "raibit-recovery-cache"
)

type recoveryHelperOperation string

const (
	recoveryHelperVerify  recoveryHelperOperation = "verify"
	recoveryHelperDump    recoveryHelperOperation = "dump"
	recoveryHelperRestore recoveryHelperOperation = "restore"
	recoveryHelperBackup  recoveryHelperOperation = "backup"
)

type recoveryHelperStepContract struct {
	action  string
	binding StreamBinding
}

type recoveryHelperSequenceContract struct {
	first, second recoveryHelperStepContract
}

type recoveryHelperContract struct {
	executable    string
	dump, restore recoveryHelperSequenceContract
}

type EndpointProjection struct {
	host, database, username string
	port                     uint16
	index                    *uint16
}

func projectEndpoint(endpoint Endpoint) (EndpointProjection, bool) {
	value, ok := endpoint.(NetworkEndpoint)
	if !ok {
		return EndpointProjection{}, false
	}
	projection := EndpointProjection{host: value.spec.Host, port: value.spec.Port, database: value.spec.Database, username: value.spec.User}
	if value.spec.Index != nil {
		index := *value.spec.Index
		projection.index = &index
	}
	return projection, true
}

func (p EndpointProjection) Host() string     { return p.host }
func (p EndpointProjection) Port() uint16     { return p.port }
func (p EndpointProjection) Database() string { return p.database }
func (p EndpointProjection) Username() string { return p.username }
func (p EndpointProjection) Index() (uint16, bool) {
	if p.index == nil {
		return 0, false
	}
	return *p.index, true
}

type endpointEnvironmentVariable struct{ name, value string }

func (p EndpointProjection) environment() []endpointEnvironmentVariable {
	variables := []endpointEnvironmentVariable{
		{name: endpointHostEnv, value: p.host},
		{name: endpointPortEnv, value: strconv.FormatUint(uint64(p.port), 10)},
	}
	if p.database != "" {
		variables = append(variables, endpointEnvironmentVariable{name: endpointDatabaseEnv, value: p.database})
	}
	variables = append(variables, endpointEnvironmentVariable{name: endpointUsernameEnv, value: p.username})
	if index, ok := p.Index(); ok {
		variables = append(variables, endpointEnvironmentVariable{name: endpointIndexEnv, value: strconv.FormatUint(uint64(index), 10)})
	}
	return variables
}

// recoveryHelperCommand classifies the narrowly reserved helper protocol.
// Every other executable remains subject to normal endpoint-leak detection.
func recoveryHelperCommand(steps []CommandStep, engine Engine) (present, valid bool) {
	for _, step := range steps {
		if strings.HasPrefix(step.command.executable, "raibit-recovery-") {
			present = true
		}
	}
	if !present || len(steps) != 2 {
		return present, false
	}
	expected, ok := recoveryHelperContractFor(engine)
	if !ok {
		return true, false
	}
	return true, helperSequenceMatches(steps, expected.executable, expected.dump) || helperSequenceMatches(steps, expected.executable, expected.restore)
}

func recoveryHelperContractFor(engine Engine) (recoveryHelperContract, bool) {
	var executable, prefix string
	var streamedOperation recoveryHelperOperation
	switch engine {
	case EnginePostgreSQL, EngineMySQL, EngineMariaDB, EngineMongoDB:
		executable, prefix, streamedOperation = recoveryDatabaseHelper, string(engine), recoveryHelperDump
	case EngineRedis, EngineValkey:
		executable, prefix, streamedOperation = recoveryCacheHelper, string(engine), recoveryHelperBackup
	default:
		return recoveryHelperContract{}, false
	}
	verify := helperAction(prefix, recoveryHelperVerify)
	streamed := helperAction(prefix, streamedOperation)
	restore := helperAction(prefix, recoveryHelperRestore)
	return recoveryHelperContract{
		executable: executable,
		dump: recoveryHelperSequenceContract{
			first:  recoveryHelperStepContract{action: verify, binding: StreamNone},
			second: recoveryHelperStepContract{action: streamed, binding: StreamStdout},
		},
		restore: recoveryHelperSequenceContract{
			first:  recoveryHelperStepContract{action: restore, binding: StreamStdin},
			second: recoveryHelperStepContract{action: verify, binding: StreamNone},
		},
	}, true
}

func helperAction(prefix string, operation recoveryHelperOperation) string {
	return prefix + "-" + string(operation)
}

func helperSequenceMatches(steps []CommandStep, executable string, sequence recoveryHelperSequenceContract) bool {
	return helperStepMatches(steps[0], executable, sequence.first) && helperStepMatches(steps[1], executable, sequence.second)
}

func helperStepMatches(step CommandStep, executable string, expected recoveryHelperStepContract) bool {
	command := step.command
	return command.executable == executable && len(command.args) == 1 && command.args[0] == expected.action && step.binding == expected.binding
}

// commandLeaksEndpoint keeps server-owned host and volume paths out of argv.
// Runners project the tagged endpoint directly into their runtime representation.
func commandLeaksEndpoint(steps []CommandStep, connection Connection) bool {
	helperPresent, helperValid := recoveryHelperCommand(steps, connection.Engine())
	if helperPresent && !helperValid {
		return true
	}
	identities := endpointIdentities(connection.Endpoint())
	for _, step := range steps {
		if helperValid {
			continue
		}
		for _, identity := range identities {
			if strings.Contains(step.command.executable, identity) {
				return true
			}
			for _, arg := range step.command.args {
				if strings.Contains(arg, identity) {
					return true
				}
			}
		}
	}
	return false
}

func endpointIdentities(endpoint Endpoint) []string {
	switch value := endpoint.(type) {
	case NetworkEndpoint:
		projection, _ := projectEndpoint(value)
		identities := make([]string, 0, 5)
		for _, variable := range projection.environment() {
			identities = append(identities, variable.value)
		}
		return identities
	case SQLiteEndpoint:
		return []string{value.spec.Volume, value.spec.Root, value.spec.RelativePath}
	default:
		return []string{""}
	}
}

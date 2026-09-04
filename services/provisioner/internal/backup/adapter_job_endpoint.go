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
)

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

// commandLeaksEndpoint keeps server-owned host and volume paths out of argv.
// Runners project the tagged endpoint directly into their runtime representation.
func commandLeaksEndpoint(steps []CommandStep, endpoint Endpoint) bool {
	identities := endpointIdentities(endpoint)
	for _, step := range steps {
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

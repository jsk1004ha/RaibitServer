package backup

import "strings"

// commandLeaksEndpoint keeps server-owned host and volume paths out of argv.
// Runners project the tagged endpoint directly into their runtime representation.
func commandLeaksEndpoint(steps []CommandStep, endpoint Endpoint) bool {
	identities := endpointIdentities(endpoint)
	for _, step := range steps {
		for _, arg := range step.command.args {
			for _, identity := range identities {
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
		return []string{value.spec.Host}
	case SQLiteEndpoint:
		return []string{value.spec.Volume, value.spec.Root, value.spec.RelativePath}
	default:
		return []string{""}
	}
}

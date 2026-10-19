package controlplane

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	EnvironmentProduction  = "prod"
	EnvironmentDevelopment = "dev"

	OperationalProtocolLegacy = 1
	OperationalProtocolActive = 2
)

var ErrEnvironmentIdentity = errors.New("authoritative environment identity is invalid")

func OperationalProtocolFromEnv(env map[string]string) (int, error) {
	raw := strings.TrimSpace(env["RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION"])
	if raw == "" {
		return OperationalProtocolLegacy, nil
	}
	version, err := strconv.Atoi(raw)
	if err != nil || (version != OperationalProtocolLegacy && version != OperationalProtocolActive) {
		return 0, errors.New("operational protocol version must be 1 or 2")
	}
	return version, nil
}

func BindDeploymentEnvironment(service *Service, deployment *Deployment) error {
	if service == nil || deployment == nil {
		return ErrEnvironmentIdentity
	}
	if err := normalizeServiceEnvironment(service); err != nil {
		return err
	}
	if deployment.EnvironmentID == "" && deployment.EnvironmentKind == "" && deployment.LogicalSlug == "" {
		if service.EnvironmentKind != EnvironmentProduction {
			return fmt.Errorf("%w: development deployment has no environment identity", ErrEnvironmentIdentity)
		}
		deployment.EnvironmentKind = EnvironmentProduction
		deployment.LogicalSlug = service.LogicalSlug
		return nil
	}
	if deployment.EnvironmentID == "" && deployment.EnvironmentKind == EnvironmentProduction && deployment.LogicalSlug == service.LogicalSlug && service.EnvironmentKind == EnvironmentProduction {
		return nil
	}
	if deployment.EnvironmentID == "" || deployment.EnvironmentKind == "" || deployment.LogicalSlug == "" {
		return fmt.Errorf("%w: deployment identity is incomplete", ErrEnvironmentIdentity)
	}
	if deployment.EnvironmentID != service.EnvironmentID || deployment.EnvironmentKind != service.EnvironmentKind || deployment.LogicalSlug != service.LogicalSlug {
		return fmt.Errorf("%w: deployment and service bindings differ", ErrEnvironmentIdentity)
	}
	return nil
}

func normalizeServiceEnvironment(service *Service) error {
	if service.EnvironmentID == "" && service.EnvironmentKind == "" && service.LogicalSlug == "" {
		service.EnvironmentKind = EnvironmentProduction
		service.LogicalSlug = service.Slug
		return nil
	}
	if service.EnvironmentID == "" {
		if service.EnvironmentKind == EnvironmentProduction && service.LogicalSlug == service.Slug {
			return nil
		}
		return fmt.Errorf("%w: service binding is incomplete", ErrEnvironmentIdentity)
	}
	if service.EnvironmentKind != EnvironmentProduction && service.EnvironmentKind != EnvironmentDevelopment {
		return fmt.Errorf("%w: unsupported environment kind", ErrEnvironmentIdentity)
	}
	if service.LogicalSlug == "" {
		return fmt.Errorf("%w: service binding is incomplete", ErrEnvironmentIdentity)
	}
	if service.EnvironmentKind == EnvironmentProduction && service.LogicalSlug != service.Slug {
		return fmt.Errorf("%w: production physical slug changed", ErrEnvironmentIdentity)
	}
	return nil
}

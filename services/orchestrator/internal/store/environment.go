package store

import (
	"errors"
	"strings"
)

type EnvironmentKind string

const (
	EnvironmentKindProd           EnvironmentKind = "prod"
	EnvironmentKindDev            EnvironmentKind = "dev"
	operationalProtocolSessionSQL                 = "SET LOCAL raibitserver.operational_protocol = '2'"
)

var ErrEnvironmentBinding = errors.New("deployment environment does not match service binding")

func (service Service) RuntimeEnvironment(deployment Deployment) (EnvironmentKind, error) {
	kind := EnvironmentKind(strings.ToLower(strings.TrimSpace(string(service.EnvironmentKind))))
	if kind == "" {
		kind = EnvironmentKindProd
	}
	if kind != EnvironmentKindProd && kind != EnvironmentKindDev {
		return "", errors.New("service environment kind is invalid")
	}
	if kind == EnvironmentKindDev && (service.EnvironmentID == "" || service.LogicalSlug == "") {
		return "", errors.New("dev service environment binding is incomplete")
	}
	if deployment.EnvironmentID != "" && deployment.EnvironmentID != service.EnvironmentID {
		return "", ErrEnvironmentBinding
	}
	if kind == EnvironmentKindDev && deployment.EnvironmentID == "" {
		return "", ErrEnvironmentBinding
	}
	return kind, nil
}

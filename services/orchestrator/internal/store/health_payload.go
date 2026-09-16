package store

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var healthDNSLabel = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

func parseHealthObservation(raw []byte) (HealthObservation, error) {
	var payload HealthObservation
	if len(raw) > 8192 {
		return payload, ErrHealthObservation
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, ErrHealthObservation
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return payload, ErrHealthObservation
	}
	if !validObservation(payload) {
		return payload, ErrHealthObservation
	}
	return payload, nil
}

func validObservation(p HealthObservation) bool {
	if p.Version != 1 || p.RolloutAttempt < 1 || p.ObservedGeneration < 1 || p.ObservedGeneration > math.MaxInt32 || p.AbsoluteDeadline.IsZero() {
		return false
	}
	for _, value := range []string{p.ProjectID, p.ServiceID, p.DeploymentID, p.WorkloadUID} {
		if value == "" || len(value) > 256 || !utf8.ValidString(value) || strings.ContainsFunc(value, unicode.IsSpace) || strings.ContainsFunc(value, unicode.IsControl) {
			return false
		}
	}
	if len(p.Namespace) > 63 || !healthDNSLabel.MatchString(p.Namespace) || len(p.WorkloadName) > 253 {
		return false
	}
	for _, label := range strings.Split(p.WorkloadName, ".") {
		if len(label) > 63 || !healthDNSLabel.MatchString(label) {
			return false
		}
	}
	if !p.Public {
		return p.GeneratedHost == "" && p.EffectivePath == ""
	}
	labels := strings.Split(p.GeneratedHost, ".")
	if len(labels) < 3 || len(p.GeneratedHost) > 253 || !(strings.HasPrefix(labels[0], "apps--") || strings.HasPrefix(labels[0], "preview--pr-")) {
		return false
	}
	for _, label := range labels {
		if len(label) > 63 || !healthDNSLabel.MatchString(label) {
			return false
		}
	}
	return validHealthPath(p.EffectivePath)
}

func validHealthPath(path string) bool {
	if len(path) == 0 || len(path) > 1024 || !utf8.ValidString(path) || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return false
	}
	if strings.ContainsAny(path, "\\?#") || strings.ContainsFunc(path, unicode.IsSpace) || strings.ContainsFunc(path, unicode.IsControl) {
		return false
	}
	decoded, err := url.PathUnescape(path)
	if err != nil || !utf8.ValidString(decoded) || strings.ContainsAny(decoded, "\\?#%") || strings.ContainsFunc(decoded, unicode.IsSpace) || strings.ContainsFunc(decoded, unicode.IsControl) {
		return false
	}
	if strings.Count(decoded, "/") != strings.Count(path, "/") {
		return false
	}
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func rolloutObservation(input RolloutCompletion) (*HealthObservation, error) {
	if input.Observation == nil {
		return nil, nil
	}
	p := *input.Observation
	p.Version = 1
	p.AbsoluteDeadline = healthClock(input.Now).Add(HealthObservationWindow)
	if p.DeploymentID != input.Lease.DeploymentID || p.RolloutAttempt != input.Lease.Attempt || !validObservation(p) {
		return nil, ErrHealthObservation
	}
	return &p, nil
}

package identity

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	dnsPattern    = regexp.MustCompile(`[^a-z0-9-]+`)
	digestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

func normalize(value string) string {
	value = strings.Trim(dnsPattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-")
	if value == "" {
		return "item"
	}
	return value
}

func suffix(value string) string {
	hash := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", hash[:6])
}

func bounded(value, id string, limit int) string {
	value = normalize(value)
	if len(value) <= limit {
		return value
	}
	return strings.TrimRight(value[:limit-13], "-") + "-" + suffix(first(id, value))
}

func previewName(name string, input Input) string {
	value := normalize("pr-" + strconv.Itoa(input.PullRequestNumber) + "-" + name)
	if len(value) > 50 {
		value = strings.TrimRight(value[:50], "-")
	}
	return value + "-" + suffix(input.DeploymentID)
}

func first(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

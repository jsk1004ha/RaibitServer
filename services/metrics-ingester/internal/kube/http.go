package kube

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"regexp"

	"github.com/raibitserver/metrics-ingester/internal/ingester"
)

var namePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)

func validName(value string, limit int) bool {
	return len(value) <= limit && namePattern.MatchString(value)
}

func (c *Client) get(ctx context.Context, path string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return &ingester.Failure{Code: "configuration"}
	}
	token, err := c.bearerToken()
	if err != nil {
		return &ingester.Failure{Code: "configuration"}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &ingester.Failure{Code: "http_transport"}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &ingester.Failure{Code: "http_status"}
	}
	const maxObject = 1024 * 1024
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxObject+1))
	if err != nil {
		return &ingester.Failure{Code: "http_transport"}
	}
	if err := ingester.ConsumeBytes(ctx, len(payload)); err != nil {
		return err
	}
	if len(payload) > maxObject {
		return &ingester.Failure{Code: "byte_limit"}
	}
	if err := json.Unmarshal(payload, target); err != nil {
		return &ingester.Failure{Code: "http_decode"}
	}
	return nil
}

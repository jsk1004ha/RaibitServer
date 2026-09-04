package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const previewGitHubResponseLimit = 1 << 20

var (
	previewRepositoryOwnerPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)
	previewRepositoryNamePattern  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
	previewSHA                    = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)
	previewRefPattern             = regexp.MustCompile(`^[^\s\x00-\x1f\x7f~^:?*\[\\]+$`)
)

type PreviewResolutionTarget struct {
	LineageID         string
	LineageVersion    int
	InstallationID    string
	RepositoryID      string
	Repository        string
	PullRequestNumber int
}

type PreviewResolutionObservation struct {
	Version           int       `json:"version"`
	LineageID         string    `json:"lineageId"`
	LineageVersion    int       `json:"lineageVersion"`
	InstallationID    string    `json:"installationId"`
	RepositoryID      string    `json:"repositoryId"`
	PullRequestNumber int       `json:"pullRequestNumber"`
	State             string    `json:"state"`
	HeadSHA           string    `json:"headSha"`
	HeadRef           string    `json:"headRef"`
	BaseRef           string    `json:"baseRef"`
	UpdatedAt         time.Time `json:"updatedAt"`
	ObservedAt        time.Time `json:"observedAt"`
}

type GitHubPullRequestClient struct {
	apiURL string
	client *http.Client
}

func NewGitHubPullRequestClient(apiURL string, client *http.Client) (*GitHubPullRequestClient, error) {
	apiURL = strings.TrimRight(strings.TrimSpace(apiURL), "/")
	if apiURL == "" {
		apiURL = defaultGitHubAPIURL
	}
	parsed, err := url.Parse(apiURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("GitHub API URL must be an https URL without credentials, query parameters, or fragments")
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	copyClient := *client
	copyClient.Timeout = 15 * time.Second
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &GitHubPullRequestClient{apiURL: apiURL, client: &copyClient}, nil
}

func (c *GitHubPullRequestClient) Observe(ctx context.Context, token string, target PreviewResolutionTarget, observedAt time.Time) (*PreviewResolutionObservation, error) {
	parts := strings.Split(target.Repository, "/")
	if len(parts) != 2 || !previewRepositoryOwnerPattern.MatchString(parts[0]) || !previewRepositoryNamePattern.MatchString(parts[1]) || target.PullRequestNumber <= 0 {
		return nil, errors.New("trusted preview repository identity is invalid")
	}
	requestURL := c.apiURL + "/repos/" + url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1]) + "/pulls/" + strconv.Itoa(target.PullRequestNumber)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, errors.New("create GitHub pull request observation")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := c.client.Do(request)
	if err != nil {
		return nil, errors.New("GitHub pull request observation transport failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub pull request observation returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, previewGitHubResponseLimit+1))
	if err != nil {
		return nil, errors.New("read GitHub pull request observation")
	}
	if len(body) > previewGitHubResponseLimit {
		return nil, errors.New("GitHub pull request observation exceeds size limit")
	}
	var payload struct {
		Number    int       `json:"number"`
		State     string    `json:"state"`
		UpdatedAt time.Time `json:"updated_at"`
		Head      struct {
			SHA string `json:"sha"`
			Ref string `json:"ref"`
		} `json:"head"`
		Base struct {
			Ref  string `json:"ref"`
			Repo struct {
				ID int64 `json:"id"`
			} `json:"repo"`
		} `json:"base"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, errors.New("GitHub pull request observation is invalid")
	}
	repositoryID, err := strconv.ParseInt(target.RepositoryID, 10, 64)
	if err != nil || repositoryID <= 0 || repositoryID > 9007199254740991 || payload.Base.Repo.ID != repositoryID || payload.Number != target.PullRequestNumber {
		return nil, errors.New("GitHub pull request observation identity mismatch")
	}
	state := strings.ToLower(strings.TrimSpace(payload.State))
	if state != "open" && state != "closed" {
		return nil, errors.New("GitHub pull request observation state is invalid")
	}
	if !previewSHA.MatchString(payload.Head.SHA) || !validPreviewRef(payload.Head.Ref) || !validPreviewRef(payload.Base.Ref) || payload.UpdatedAt.IsZero() || payload.UpdatedAt.Location() != time.UTC || !payload.UpdatedAt.Equal(payload.UpdatedAt.Truncate(time.Millisecond)) {
		return nil, errors.New("GitHub pull request observation fields are invalid")
	}
	return &PreviewResolutionObservation{
		Version: 1, LineageID: target.LineageID, LineageVersion: target.LineageVersion,
		InstallationID: target.InstallationID, RepositoryID: target.RepositoryID, PullRequestNumber: target.PullRequestNumber,
		State: state, HeadSHA: payload.Head.SHA, HeadRef: payload.Head.Ref, BaseRef: payload.Base.Ref,
		UpdatedAt: payload.UpdatedAt.UTC(), ObservedAt: observedAt.UTC().Truncate(time.Millisecond),
	}, nil
}

func validPreviewRef(value string) bool {
	if value == "" || len(value) > 255 || !previewRefPattern.MatchString(value) || value == "@" || strings.Contains(value, "..") || strings.Contains(value, "@{") || strings.HasSuffix(value, ".") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return true
}

package redact

import (
	"regexp"
	"strings"
)

// State persists only finite parser state, never secret source bytes.
type State struct {
	Version   int    `json:"v"`
	PEM       bool   `json:"pem"`
	Quote     string `json:"quote,omitempty"`
	Uncertain bool   `json:"uncertain,omitempty"`
	Sequence  uint64 `json:"sequence"`
	Watermark string `json:"watermark,omitempty"`
}

func (state State) Valid() bool {
	return state.Version == 1 && (state.Quote == "" || state.Quote == "\"" || state.Quote == "'" || state.Quote == `\"` || state.Quote == `\'`)
}

const (
	sensitiveFragment = `(?:password|passwd|secret|token|credential|apikey|api_key|api-key|accesskey|access_key|access-key|privatekey|private_key|private-key|databaseurl|database_url|database-url|mongodburi|mongodb_uri|mongodb-uri|redisurl|redis_url|redis-url)`
	sensitiveName     = `-{0,2}(?:[A-Za-z0-9_-]*` + sensitiveFragment + `[A-Za-z0-9_-]*|key)`
	sensitiveKey      = `(?:"` + sensitiveName + `"|'` + sensitiveName + `'|\\"` + sensitiveName + `\\"|\\'` + sensitiveName + `\\'|` + sensitiveName + `)`
	keyPrefix         = `(?i)((?:^|[^A-Za-z0-9_-])` + sensitiveKey + `\s*[:=]\s*)`
)

var (
	beginPEM      = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	partialPEM    = regexp.MustCompile(`-----BEGIN(?: [A-Z0-9 ]*)?-{0,4}$`)
	endPEM        = regexp.MustCompile(`-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	credentialURL = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)([^\s:/@]*):([^\s@]+)@`)
	assignment    = regexp.MustCompile(keyPrefix + `([^\s,;&]+)`)
	query         = regexp.MustCompile(`(?i)([?&]` + sensitiveName + `\s*=\s*)([^\s&]+)`)
	quoted        = regexp.MustCompile(keyPrefix + `(\\["']|["'])`)
	authorization = regexp.MustCompile(`(?i)(\b(?:bearer|basic)\s+)[^\s,;"']+`)
	cookie        = regexp.MustCompile(`(?i)((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+`)
	jwt           = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	knownToken    = regexp.MustCompile(`(?i)\b(?:ghp_|github_pat_|glpat-|sk-|xox[baprs]-)[A-Za-z0-9_-]+`)
)

func Line(value string, state State) (string, State) {
	state.Version = 1
	if state.Uncertain {
		return "****", state
	}
	var out strings.Builder
	if !state.PEM && !beginPEM.MatchString(value) {
		if at := partialPEM.FindStringIndex(value); at != nil {
			state.PEM = true
			return mask(value[:at[0]]) + "****", state
		}
	}
	for state.PEM || beginPEM.MatchString(value) {
		if !state.PEM {
			at := beginPEM.FindStringIndex(value)
			out.WriteString(value[:at[0]])
			value = value[at[1]:]
			state.PEM = true
		}
		out.WriteString("****")
		end := endPEM.FindStringIndex(value)
		if end == nil {
			return mask(out.String()), state
		}
		value = value[end[1]:]
		state.PEM = false
	}
	if state.Quote != "" {
		end := closingDelimiter(value, state.Quote)
		out.WriteString("****")
		if end < 0 {
			return mask(out.String()), state
		}
		value = value[end:]
		state.Quote = ""
	}
	for {
		at := quoted.FindStringSubmatchIndex(value)
		if at == nil {
			break
		}
		out.WriteString(value[:at[1]])
		quote := value[at[4]:at[5]]
		value = value[at[1]:]
		end := closingDelimiter(value, quote)
		out.WriteString("****")
		if end < 0 {
			out.WriteString(quote)
			state.Quote = quote
			return mask(out.String()), state
		}
		out.WriteString(quote)
		value = value[end+1:]
		if len(quote) == 2 {
			value = value[1:]
		}
	}
	out.WriteString(value)
	return mask(out.String()), state
}

func closingDelimiter(value, delimiter string) int {
	if len(delimiter) == 1 {
		return closingQuote(value, delimiter[0])
	}
	search := 0
	for {
		at := strings.Index(value[search:], delimiter)
		if at < 0 {
			return -1
		}
		at += search
		slashes := 0
		for index := at - 1; index >= 0 && value[index] == '\\'; index-- {
			slashes++
		}
		if slashes%4 != 2 {
			return at
		}
		search = at + len(delimiter)
	}
}

func closingQuote(value string, quote byte) int {
	escaped := false
	for index := 0; index < len(value); index++ {
		if escaped {
			escaped = false
			continue
		}
		if value[index] == '\\' {
			escaped = true
			continue
		}
		if value[index] == quote {
			return index
		}
	}
	return -1
}

func mask(value string) string {
	value = credentialURL.ReplaceAllStringFunc(value, func(match string) string {
		parts := credentialURL.FindStringSubmatch(match)
		user := ""
		if parts[2] != "" {
			user = "****"
		}
		return parts[1] + user + ":****@"
	})
	value = authorization.ReplaceAllString(value, `${1}****`)
	value = cookie.ReplaceAllString(value, `${1}****`)
	value = jwt.ReplaceAllString(value, "****")
	value = knownToken.ReplaceAllString(value, "****")
	value = query.ReplaceAllStringFunc(value, func(match string) string {
		return maskAssignment(query, match)
	})
	return assignment.ReplaceAllStringFunc(value, func(match string) string {
		return maskAssignment(assignment, match)
	})
}

func maskAssignment(pattern *regexp.Regexp, match string) string {
	parts := pattern.FindStringSubmatch(match)
	if strings.HasPrefix(parts[2], `"`) || strings.HasPrefix(parts[2], `'`) || strings.HasPrefix(parts[2], `\"`) || strings.HasPrefix(parts[2], `\'`) {
		return match
	}
	return parts[1] + "****"
}

func Text(value string) string { result, _ := Line(value, State{Version: 1}); return result }

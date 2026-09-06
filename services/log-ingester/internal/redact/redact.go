package redact

import (
	"regexp"
	"strings"
)

// State persists only finite parser state, never secret source bytes.
type State struct {
	Version  int    `json:"v"`
	PEM      bool   `json:"pem"`
	Quote    string `json:"quote,omitempty"`
	Sequence uint64 `json:"sequence"`
}

var (
	beginPEM      = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	partialPEM    = regexp.MustCompile(`-----BEGIN(?: [A-Z0-9 ]*)?-{0,4}$`)
	endPEM        = regexp.MustCompile(`-----END [A-Z0-9 ]*PRIVATE KEY-----`)
	credentialURL = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://)([^\s:/@]*):([^\s@]+)@`)
	assignment    = regexp.MustCompile(`(?i)(\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|database_url|mongodb_uri|redis_url)\s*[=:]\s*)([^\s,;&]+)`)
	quoted        = regexp.MustCompile(`(?i)((?:["'](?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|database_url|mongodb_uri|redis_url)["']|\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|database_url|mongodb_uri|redis_url))\s*[:=]\s*)(["'])`)
	escapedQuoted = regexp.MustCompile(`(?i)(\\"(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|database_url|mongodb_uri|redis_url)\\"\s*:\s*\\")(.*?)(\\")`)
	authorization = regexp.MustCompile(`(?i)(\b(?:bearer|basic)\s+)[^\s,;"']+`)
	cookie        = regexp.MustCompile(`(?i)((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+`)
	jwt           = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	knownToken    = regexp.MustCompile(`(?i)\b(?:ghp_|github_pat_|glpat-|sk-|xox[baprs]-)[A-Za-z0-9_-]+`)
)

func Line(value string, state State) (string, State) {
	state.Version = 1
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
		end := closingQuote(value, state.Quote[0])
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
		quote := value[at[4]]
		value = value[at[1]:]
		end := closingQuote(value, quote)
		out.WriteString("****")
		if end < 0 {
			state.Quote = string(quote)
			return mask(out.String()), state
		}
		out.WriteByte(quote)
		value = value[end+1:]
	}
	out.WriteString(value)
	return mask(out.String()), state
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
	value = escapedQuoted.ReplaceAllString(value, `${1}****${3}`)
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
	return assignment.ReplaceAllString(value, `${1}****`)
}

func Text(value string) string { result, _ := Line(value, State{Version: 1}); return result }

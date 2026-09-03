package health

import (
	"net/netip"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

type target struct{ hostname, path string }

// The caller binds Hostname to its owned generated route, not a tenant URL.
func parseTarget(request Request) (target, bool) {
	host := request.Hostname
	if len(host) > 253 || !strings.Contains(host, ".") {
		return target{}, false
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return target{}, false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return target{}, false
		}
		for _, ch := range label {
			if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
				return target{}, false
			}
		}
	}
	path := request.Path
	if len(path) == 0 || len(path) > 1024 || path[0] != '/' || strings.HasPrefix(path, "//") || !utf8.ValidString(path) {
		return target{}, false
	}
	for _, ch := range path {
		if unicode.IsSpace(ch) || unicode.IsControl(ch) || strings.ContainsRune("\\?#", ch) {
			return target{}, false
		}
	}
	decoded, err := url.PathUnescape(path)
	if err != nil || !utf8.ValidString(decoded) {
		return target{}, false
	}
	for i := 0; i < len(path); i++ {
		if path[i] != '%' {
			continue
		}
		escaped, err := url.PathUnescape(path[i : i+3])
		if err != nil || strings.ContainsAny(escaped, "/\\?#%") || escaped[0] <= 32 || escaped[0] == 127 {
			return target{}, false
		}
		i += 2
	}
	for _, ch := range decoded {
		if unicode.IsSpace(ch) || unicode.IsControl(ch) {
			return target{}, false
		}
	}
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "." || segment == ".." {
			return target{}, false
		}
	}
	return target{hostname: host, path: path}, true
}

// Fail closed for IANA special-purpose space, including globally reachable
// special services. IPv6 is restricted to ordinary 2000::/3 global unicast.
// Sources: https://www.iana.org/assignments/iana-ipv4-special-registry/
// and https://www.iana.org/assignments/iana-ipv6-special-registry/ (2026-09-03).
var forbiddenPrefixes = [...]netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"), netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.31.196.0/24"), netip.MustParsePrefix("192.52.193.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("192.175.48.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/3"), netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("2620:4f:8000::/48"), netip.MustParsePrefix("3fff::/20"),
}

func publicAddress(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" || ip.Is4In6() || !ip.IsGlobalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, prefix := range forbiddenPrefixes {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

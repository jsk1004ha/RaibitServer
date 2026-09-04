package ingester

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

var quantityPattern = regexp.MustCompile(`^([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))([numkKMGTPE]i?|[eE][+-]?[0-9]+)?$`)

func ParseQuantity(value string) (float64, error) {
	if len(value) > 64 {
		return 0, &Failure{Code: "quantity"}
	}
	match := quantityPattern.FindStringSubmatch(strings.TrimSpace(value))
	if match == nil {
		return 0, &Failure{Code: "quantity"}
	}
	number, err := strconv.ParseFloat(match[1], 64)
	if err != nil || math.IsInf(number, 0) || math.IsNaN(number) {
		return 0, &Failure{Code: "quantity"}
	}
	suffix := match[2]
	multipliers := map[string]float64{
		"": 1, "n": 1e-9, "u": 1e-6, "m": 1e-3, "k": 1e3, "K": 1e3,
		"M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15, "E": 1e18,
		"Ki": 1024, "Mi": 1024 * 1024, "Gi": 1024 * 1024 * 1024,
		"Ti": math.Pow(1024, 4), "Pi": math.Pow(1024, 5), "Ei": math.Pow(1024, 6),
	}
	multiplier, ok := multipliers[suffix]
	if !ok && (strings.HasPrefix(suffix, "e") || strings.HasPrefix(suffix, "E")) {
		exponent, parseErr := strconv.Atoi(suffix[1:])
		if parseErr == nil {
			multiplier, ok = math.Pow10(exponent), true
		}
	}
	if !ok {
		return 0, &Failure{Code: "quantity"}
	}
	result := number * multiplier
	if math.IsInf(result, 0) || math.IsNaN(result) {
		return 0, &Failure{Code: "quantity"}
	}
	return result, nil
}

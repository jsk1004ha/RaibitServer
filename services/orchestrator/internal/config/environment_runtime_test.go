package config

import "testing"

func Test_FromEnv_development_claims_require_exact_protocol_2(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{{"", false}, {"1", false}, {"02", false}, {"2", true}} {
		t.Run(test.value, func(t *testing.T) {
			t.Setenv("RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION", test.value)
			if got := FromEnv().DevelopmentEnvironments; got != test.want {
				t.Fatalf("activation=%t want=%t", got, test.want)
			}
		})
	}
}

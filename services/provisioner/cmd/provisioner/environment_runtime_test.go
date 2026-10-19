package main

import "testing"

func Test_environment_claim_activation_is_exact_protocol_2(t *testing.T) {
	for _, test := range []struct {
		value string
		want  bool
	}{{"", false}, {"1", false}, {"02", false}, {"2", true}} {
		t.Run(test.value, func(t *testing.T) {
			t.Setenv("RAIBITSERVER_OPERATIONAL_PROTOCOL_VERSION", test.value)
			if got := environmentClaimsEnabled(); got != test.want {
				t.Fatalf("activation=%t want=%t", got, test.want)
			}
		})
	}
}
